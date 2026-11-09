"""Disposable deterministic fixtures; no model reading or real Agent is certified."""
import copy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("abook_v3", ROOT / "abook_runtime_v3.py")
rt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rt)


class Run:
    def __init__(self, root, long=False, init=True, sections=None):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.work = self.root / "work"
        self.package = self.root / "package"
        self.agent = self.root / "fixture-agent.toml"
        self.source = self.root / "fixture.epub"
        entries = {
            "praise.xhtml": "<p>Other people's praise. Not an argument.</p>",
            "one.xhtml": "<p>Review 😀 to skip.</p><p>Chapter one: a definition and its condition.</p><p>ADVERTISEMENT</p><p>Author clarification: e\u0301 and 😀.</p>",
            "one-b.xhtml": "<p>Author continuation: a mechanism and its dependency.</p>",
            "two.xhtml": "<p>Chapter two: compare the causes and limits.</p>",
            "three.xhtml": "<p>Chapter three: an action, a stopping rule and limitations.</p>",
            "refs.xhtml": "<p>Bibliography: titles and publication years.</p>",
        }
        if long:
            entries["one-b.xhtml"] = "<p>" + "字😀e\u0301" * 4000 + "</p>"
        names = list(entries)
        manifest = "".join(f'<item id="e{i}" href="{name}" media-type="application/xhtml+xml"/>' for i, name in enumerate(names))
        spine = "".join(f'<itemref idref="e{i}"/>' for i in range(len(names)))
        with zipfile.ZipFile(self.source, "w") as z:
            z.writestr("META-INF/container.xml", '<container><rootfiles><rootfile full-path="book.opf"/></rootfiles></container>')
            z.writestr("book.opf", f'<package><metadata><title>Disposable fixture</title></metadata><manifest>{manifest}</manifest><spine>{spine}</spine></package>')
            for name, value in entries.items():
                z.writestr(name, value)
        text, _ = rt.open_source(self.source).section(["one.xhtml", "one-b.xhtml"])
        ad = text.index("ADVERTISEMENT")
        self.sections = sections or [
            {"id": "P", "title": "Praise", "entries": ["praise.xhtml"], "substantive": False, "kind": "endorsement", "reason": "Praise only"},
            {"id": "S1", "title": "One", "entries": ["one.xhtml", "one-b.xhtml"], "substantive": True, "kind": "content",
             "exclusions": [{"start": 0, "end": text.index("Chapter one"), "kind": "review", "reason": "Review only"},
                            {"start": ad, "end": ad + len("ADVERTISEMENT"), "kind": "promotion", "reason": "Ad only"}]},
            {"id": "S2", "title": "Two", "entries": ["two.xhtml"], "substantive": True, "kind": "content"},
            {"id": "S3", "title": "Three", "entries": ["three.xhtml"], "substantive": True, "kind": "content"},
            {"id": "B", "title": "References", "entries": ["refs.xhtml"], "substantive": False, "kind": "bibliography", "reason": "Citations only"},
        ]
        if init:
            self.initialize()

    def initialize(self, **extra):
        return self.call("init", source=str(self.source), edition="test-only", package_dir=str(self.package),
                         agent_path=str(self.agent), sections=self.sections, test_fixture=True, **extra)

    def state(self):
        return json.loads((self.work / "state.json").read_text("utf-8"))

    def call(self, op, **kw):
        request = {"op": op, "work_dir": str(self.work)}
        if (self.work / "state.json").exists():
            request["expected_revision"] = self.state()["revision"]
        request.update(kw)
        return rt.main_request(request)

    def read_all(self):
        for sid in ("S1", "S2", "S3"):
            while self.state()["reading"][sid]["status"] != "READ":
                value = self.call("read_unit", section_id=sid)
                assert "ADVERTISEMENT" not in value["text"] and "Review 😀" not in value["text"]
                self.call("commit_reading", section_id=sid, receipt=value["receipt"], evidence={"claim": "Fixture paraphrase", "locator": value["locator"]})
        return self.state()

    def maps(self):
        files = [{"target": str(self.package / f), "content": "# Fixture map\nDefinition, mechanism, condition and action.\n", "before_sha256": None} for f in sorted(rt.MARKDOWN_FILES)]
        self.call("commit_files", unit_id="maps", files=files)

    def questions(self):
        state = self.state()
        kinds = sorted(rt.QUESTION_KINDS)
        qs = []
        for i in range(20):
            sid = f"S{i % 3 + 1}"
            loc = state["reading"][sid]["checkpoints"][0]["locator"]
            qs.append({"id": f"Q{i + 1:02}", "prompt": "Explain the author claim and its condition.", "kind": kinds[i % 5],
                       "expected_elements": ["Claim", "Necessary condition"], "evidence_class": "BOOK",
                       "evidence": [{"section_id": sid, "locator": loc}], "affected_maps": ["chapter-map.md"]})
        return qs

    def freeze(self):
        self.read_all()
        self.maps()
        self.call("freeze_questions", questions=self.questions())

    def answer(self, question):
        lookups = []
        for item in question["evidence"]:
            value = self.call("lookup", source=str(self.source), locator=item["locator"])
            lookups.append({**item, "text_sha256": value["text_sha256"], "receipt": value["receipt"]})
        return {"text": "The claim is conditional; fixture paraphrase.", "lookups": lookups}

    def answers(self):
        state = self.state()
        qs = [q for q in state["questions"] if q["id"] in state["assessment"]["required_ids"] and q["id"] not in state["assessment"]["answers"]]
        for i in range(0, len(qs), 4):
            batch = {q["id"]: self.answer(q) for q in qs[i:i + 4]}
            self.call("checkpoint", unit_id=f"answers-{i}", category="answers", payload={"answers": batch})
        self.call("begin_verification")

    def verdicts(self, failed=(), critical=(), count=None):
        state = self.state()
        ids = [qid for qid in state["assessment"]["required_ids"] if qid not in state["assessment"]["verdicts"]]
        if count is not None:
            ids = ids[:count]
        for i in range(0, len(ids), 4):
            batch = [{"question_id": qid, "correct": qid not in failed, "critical": qid in critical,
                      "reason": "Fixture comparison against declared criteria", "missing_elements": ["condition"] if qid in failed else []} for qid in ids[i:i + 4]]
            self.call("checkpoint", unit_id=f"verdicts-{i}", category="verification", payload={"verdicts": batch})

    def qa(self, failed=(), critical=()):
        self.freeze()
        self.answers()
        self.verdicts(failed, critical)
        self.call("decide")

    def repair(self):
        self.call("begin_repair")
        failed = self.state()["assessment"]["failed_ids"]
        self.call("checkpoint", unit_id="repair-complete", category="validation", payload={"passed": True, "failed_ids": failed,
                  "repairs": [{"question_id": qid, "action": "answer_only", "reason": "Answer condition omitted; map already contains it", "map_files": []} for qid in failed]})
        self.call("start_retest")

    def seal(self):
        self.call("checkpoint", unit_id="package-audit", category="validation", payload={"passed": True,
                  "substantive_section_ids": ["S1", "S2", "S3"], "concepts": ["A", "B", "C"], "chapter_locators_checked": True,
                  "figures_checked": True, "conditions_checked": True, "exclusions_checked": True, "prose_overrun_reason": ""})
        self.call("prepare_manifest", unit_id="metadata")
        self.call("seal")

    def draft(self):
        return 'name="Fixture"\ndescription="Disposable test, never registered"\nmodel="gpt-5.6-sol"\nmodel_reasoning_effort="xhigh"\nsandbox_mode="read-only"\napproval_policy="never"\nweb_search="live"\ndeveloper_instructions="Fixture only"\n'

    def nlpm(self, draft):
        self.call("checkpoint", unit_id="nlpm", category="validation", payload={"passed": True, "score": 100,
                  "skills": sorted(rt.NLPM_SKILLS), "draft_sha256": rt.digest(draft.encode()), "revision_count": 0,
                  "findings": ["Simulated gate in disposable fixture; not real NLPM evidence"]})


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="abook-v3-test-")
        self.run = Run(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def reject(self, op, **kwargs):
        with self.assertRaises(rt.Rejected):
            self.run.call(op, **kwargs)

    def test_mixed_exclusions_full_coverage_and_unicode(self):
        state = self.run.read_all()
        c = self.run.call("status")["coverage"]
        self.assertEqual(c["included_percent"], 100)
        self.assertGreater(c["excluded_chars"], 0)
        self.assertEqual(state["reading"]["P"]["status"], "EXCLUDED")
        self.assertEqual(state["reading"]["S1"]["status"], "READ")
        checkpoints = state["reading"]["S1"]["checkpoints"]
        self.assertEqual(len(checkpoints), 2)
        self.assertEqual(len(checkpoints[-1]["locator"]["entries"]), 2)
        self.assertIn("é", rt.open_source(self.run.source).section(["one.xhtml"])[0])

    def test_long_section_bounded_and_entry_spans(self):
        run = Run(Path(self.tmp.name) / "long", long=True)
        run.read_all()
        for c in run.state()["reading"]["S1"]["checkpoints"]:
            value = run.call("lookup", source=str(run.source), locator=c["locator"])
            self.assertLessEqual(len(value["text"]), 6000)
            self.assertLessEqual(len(rt.encoded(value)), 24000)
            self.assertEqual(c["receipt"], value["receipt"])

    def test_order_receipt_replay_and_stale_revision(self):
        self.reject("read_unit", section_id="S2")
        value = self.run.call("read_unit", section_id="S1", max_chars=10)
        self.reject("commit_reading", section_id="S1", receipt="bad", evidence={"a": "b"})
        self.reject("commit_reading", section_id="S1", receipt=value["receipt"], evidence={"a": "b"})
        args = dict(section_id="S1", receipt=value["receipt"], evidence={"a": "b"}, max_chars=10)
        self.run.call("commit_reading", **args)
        self.assertEqual(self.run.call("commit_reading", **args)["status"], "already-committed")
        self.reject("commit_reading", **{**args, "evidence": {"a": "changed"}})
        self.reject("checkpoint", expected_revision=0, unit_id="stale", category="derived", payload={"x": 1})

    def test_bad_exclusion_and_overlapping_targets(self):
        for i, mutation in enumerate(("kind", "overlap", "reason", "all")):
            run = Run(Path(self.tmp.name) / mutation, init=False)
            if mutation == "kind":
                run.sections[0]["kind"] = "timeout"
            elif mutation == "overlap":
                run.sections[1]["exclusions"][1]["start"] = 0
            elif mutation == "reason":
                run.sections[0]["reason"] = ""
            else:
                for s in run.sections:
                    s.update(substantive=False, kind="review", reason="fixture")
                    s.pop("exclusions", None)
            with self.assertRaises(rt.Rejected):
                run.initialize()
        run = Run(Path(self.tmp.name) / "paths", init=False)
        run.package = run.work / "nested"
        with self.assertRaises(rt.Rejected):
            run.initialize()

    def test_questions_require_reading_included_windows_kinds_and_thirds(self):
        self.reject("freeze_questions", questions=[])
        self.run.read_all()
        self.run.maps()
        qs = self.run.questions()
        for variant in ("excluded", "kinds", "thirds"):
            bad = copy.deepcopy(qs)
            if variant == "excluded":
                bad[0]["evidence"][0]["locator"]["start"] = 0
            elif variant == "kinds":
                for q in bad:
                    q["kind"] = "definition"
            else:
                for q in bad:
                    q["evidence"] = bad[0]["evidence"]
            self.reject("freeze_questions", questions=bad)
        self.run.call("freeze_questions", questions=qs)
        self.reject("freeze_questions", questions=qs)

    def test_source_available_during_answering_keys_not_in_view(self):
        self.run.freeze()
        view = self.run.call("question_view")
        self.assertNotIn("expected_elements", json.dumps(view))
        self.run.answer(self.run.state()["questions"][0])
        self.run.call("reading_view", section_id="S1")
        self.run.call("view_file", path=str(self.run.package / "chapter-map.md"))
        self.reject("evidence_view", id="Q01")
        self.reject("commit_files", unit_id="early-edit", files=[{"target": str(self.run.package / "chapter-map.md"), "append": "x", "before_sha256": rt.file_hash(self.run.package / "chapter-map.md")}])

    def test_invalid_answer_receipt_duplicate_and_legacy_categories(self):
        self.run.freeze()
        q = self.run.state()["questions"][0]
        answer = self.run.answer(q)
        bad = copy.deepcopy(answer)
        bad["lookups"][0]["receipt"] = "wrong"
        self.reject("checkpoint", unit_id="bad", category="answers", payload={"answers": {"Q01": bad}})
        self.run.call("checkpoint", unit_id="a1", category="answers", payload={"answers": {"Q01": answer}})
        self.reject("checkpoint", unit_id="overwrite", category="answers", payload={"answers": {"Q01": answer}})
        for category in ("reconstruction", "score"):
            self.reject("checkpoint", unit_id=category, category=category, payload={"id": "S1", "text": "x"})
        self.reject("begin_verification")

    def test_incomplete_verification_and_critical_error_block_pass(self):
        self.run.freeze()
        self.run.answers()
        self.run.verdicts(failed=("Q01",), critical=("Q01",), count=4)
        self.reject("decide")
        # Complete remaining IDs with distinct immutable batch IDs.
        state = self.run.state()
        for qid in state["assessment"]["required_ids"][4:]:
            self.run.call("checkpoint", unit_id="v-" + qid, category="verification", payload={"verdicts": [{"question_id": qid,
                          "correct": True, "critical": False, "reason": "fixture", "missing_elements": []}]})
        self.run.call("decide")
        self.assertEqual(self.run.state()["assessment"]["correct"], 19)
        self.assertEqual(self.run.state()["assessment"]["phase"], "FAILED")
        self.reject("seal")

    def test_one_local_repair_keeps_unselected_answers(self):
        self.run.qa(failed=("Q01", "Q02", "Q03"))
        first = copy.deepcopy(self.run.state()["assessment"])
        self.run.repair()
        state = self.run.state()
        self.assertEqual(state["round_1"], first)
        self.assertEqual(len(state["assessment"]["required_ids"]), 6)
        self.assertEqual(len(state["assessment"]["answers"]), 14)
        for key, value in state["assessment"]["answers"].items():
            self.assertEqual(value, first["answers"][key])
        self.run.answers()
        self.run.verdicts()
        self.run.call("decide")
        self.assertEqual(self.run.state()["assessment"]["phase"], "PASSED_GROUNDED")
        self.reject("begin_repair")
        self.reject("start_retest")

    def test_second_failure_is_terminal_and_retest_sample_must_pass(self):
        self.run.qa(failed=("Q01", "Q02", "Q03"))
        self.run.repair()
        sample = next(k for k in self.run.state()["assessment"]["required_ids"] if k not in {"Q01", "Q02", "Q03"})
        self.run.answers()
        self.run.verdicts(failed=(sample,))
        self.run.call("decide")
        self.assertEqual(self.run.state()["assessment"]["correct"], 19)
        self.assertEqual(self.run.state()["assessment"]["phase"], "FAILED")
        self.reject("begin_repair")

    def test_map_repair_scope_and_false_repair_record(self):
        self.run.qa(failed=("Q01", "Q02", "Q03"))
        self.run.call("begin_repair")
        self.reject("commit_files", unit_id="outside-repair", files=[{"target": str(self.run.package / "README.md"), "append": "x", "before_sha256": rt.file_hash(self.run.package / "README.md")}])
        self.reject("start_retest")
        self.run.call("checkpoint", unit_id="repair-complete", category="validation", payload={"passed": True, "failed_ids": ["Q01", "Q02", "Q03"],
                      "repairs": [{"question_id": k, "action": "maps_corrected", "reason": "fake change", "map_files": ["chapter-map.md"]} for k in ("Q01", "Q02", "Q03")]})
        self.reject("start_retest")
        self.run.call("commit_files", unit_id="real-repair", files=[{"target": str(self.run.package / "chapter-map.md"), "append": "Condition clarified.\n", "before_sha256": rt.file_hash(self.run.package / "chapter-map.md")}])
        self.run.call("start_retest")

    def test_seal_metadata_generated_and_package_immutable(self):
        self.run.qa(failed=("Q01", "Q02"))
        self.assertEqual(self.run.state()["assessment"]["phase"], "PASSED_GROUNDED")
        self.reject("prepare_manifest", unit_id="early-metadata")
        self.run.seal()
        ledger = json.loads((self.run.package / "coverage-ledger.json").read_text())
        self.assertEqual(ledger["closed_book_mastery"], "NOT_PERFORMED")
        self.assertEqual(ledger["assessment_profile"], rt.PROFILE)
        self.assertEqual(set(p.name for p in self.run.package.iterdir()), rt.PACKAGE_FILES)
        self.reject("commit_files", unit_id="sealed-edit", files=[{"target": str(self.run.package / "README.md"), "append": "x", "before_sha256": rt.file_hash(self.run.package / "README.md")}])
        self.reject("complete")

    def test_generated_agent_nlpm_model_and_completion_gates(self):
        self.run.qa()
        self.run.seal()
        draft = self.run.draft()
        files = [{"target": str(self.run.agent), "content": draft, "before_sha256": None}]
        self.reject("commit_files", unit_id="agent", files=files)
        self.run.nlpm(draft)
        wrong = copy.deepcopy(files)
        wrong[0]["content"] = draft.replace("xhigh", "high")
        self.reject("commit_files", unit_id="wrong-draft", files=wrong)
        self.run.call("commit_files", unit_id="agent", files=files)
        sha = rt.file_hash(self.run.agent)
        self.run.call("checkpoint", unit_id="toml", category="validation", payload={"passed": True, "model": "gpt-5.6-sol", "model_reasoning_effort": "xhigh", "agent_sha256": sha})
        self.run.call("checkpoint", unit_id="doctor", category="validation", payload={"passed": True, "exit_code": 0, "config_load": "ok", "evidence": "SIMULATED FIXTURE ONLY"})
        self.reject("complete")
        self.run.call("checkpoint", unit_id="parent-canary", category="validation", payload={"passed": True, "runtime_identity_verified": True, "agent_sha256": sha, "evidence": "SIMULATED FIXTURE ONLY, NOT A MODEL RUN"})
        self.run.call("complete")
        self.assertEqual(self.run.state()["stage"], "COMPLETE")
        (self.run.package / "README.md").write_text("externally changed")
        self.reject("complete")

    def test_source_drift_and_legacy_state_rejected(self):
        before = self.run.state()
        changed = copy.deepcopy(before)
        changed["schema_version"] = 2
        (self.run.work / "state.json").write_bytes(rt.encoded(changed))
        self.reject("status")
        (self.run.work / "state.json").write_bytes(rt.encoded(before))
        self.run.source.write_bytes(self.run.source.read_bytes() + b"drift")
        self.reject("status")

    def test_evidence_map_changes_and_post_pass_edits_rejected(self):
        self.run.qa()
        path = self.run.package / "chapter-map.md"
        self.reject("commit_files", unit_id="post-pass-edit", files=[{"target": str(path), "append": "changed", "before_sha256": rt.file_hash(path)}])
        path.write_text("external edit", encoding="utf-8")
        self.reject("status")

    def test_correct_verdict_with_missing_required_condition_rejected(self):
        self.run.freeze()
        self.run.answers()
        self.reject("checkpoint", unit_id="contradictory", category="verification", payload={"verdicts": [{"question_id": "Q01",
                    "correct": True, "critical": False, "reason": "condition missing", "missing_elements": ["necessary condition"]}]})

    def test_frozen_answers_and_first_round_tampering_rejected(self):
        self.run.qa(failed=("Q01", "Q02", "Q03"))
        self.run.repair()
        state = self.run.state()
        state["round_1"]["answers"]["Q01"]["text"] = "changed"
        (self.run.work / "state.json").write_bytes(rt.encoded(state))
        self.reject("status")

    def test_crash_recovery_and_exact_replay(self):
        for point in ("after_journal", "after_file_0", "after_state"):
            with self.subTest(point=point):
                run = Run(Path(self.tmp.name) / point)
                request = {"op": "commit_files", "work_dir": str(run.work), "expected_revision": 0,
                           "unit_id": "crash-unit", "fault": point,
                           "files": [{"target": str(run.package / "README.md"), "content": "Expected bytes 😀\n", "before_sha256": None}]}
                result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(ROOT / "abook_runtime_v3.py"), "--request", "-"],
                                        input=rt.encoded(request), capture_output=True, timeout=20,
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                self.assertEqual(result.returncode, 86, result.stdout + result.stderr)
                run.call("recover")
                self.assertEqual(run.state()["revision"], 1)
                self.assertEqual((run.package / "README.md").read_text("utf-8"), "Expected bytes 😀\n")
                self.assertFalse((run.work / "journal.json").exists())
                request.pop("fault")
                self.assertEqual(rt.main_request(request)["status"], "already-committed")
                self.assertEqual(run.state()["revision"], 1)

    def test_cli_rejected_request_has_exit_two_and_json(self):
        result = subprocess.run([sys.executable, "-B", "-X", "utf8", str(ROOT / "abook_runtime_v3.py"), "--request", "-"],
                                input=rt.encoded({"op": "unknown", "work_dir": str(self.run.work)}), capture_output=True,
                                timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["status"], "validation-failed")


if __name__ == "__main__":
    unittest.main(verbosity=2)
