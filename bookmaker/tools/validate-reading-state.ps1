[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $StatePath,

    [string] $ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = 'Stop'
$errors = [System.Collections.Generic.List[string]]::new()

function Add-ValidationError {
    param([string] $Message)
    $errors.Add($Message)
}

function Require-Property {
    param(
        [object] $Object,
        [string] $Property,
        [string] $Context
    )

    if ($null -eq $Object -or $Object.PSObject.Properties.Name -notcontains $Property) {
        Add-ValidationError "$Context is missing required property '$Property'"
        return $false
    }
    return $true
}

function Require-Unique {
    param(
        [object[]] $Items,
        [string] $Property,
        [string] $Context
    )

    $values = @($Items | ForEach-Object { $_.$Property })
    $duplicates = @($values | Group-Object | Where-Object Count -gt 1 | ForEach-Object Name)
    foreach ($duplicate in $duplicates) {
        Add-ValidationError "$Context contains duplicate $Property '$duplicate'"
    }
}

function Test-Sha256 {
    param([object] $Value)
    return $Value -is [string] -and $Value -match '^[0-9a-f]{64}$'
}

function Test-Timestamp {
    param([object] $Value)
    $parsed = [DateTimeOffset]::MinValue
    return $Value -is [string] -and [DateTimeOffset]::TryParse($Value, [ref]$parsed) -and $Value -match '[+-]\d{2}:\d{2}$'
}

function Test-ProjectContainedPath {
    param([object] $Value)
    if ($null -eq $Value) { return $true }
    try {
        $root = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar)
        $candidate = if ([System.IO.Path]::IsPathRooted([string]$Value)) {
            [System.IO.Path]::GetFullPath([string]$Value)
        }
        else {
            [System.IO.Path]::GetFullPath((Join-Path $root ([string]$Value)))
        }
        return $candidate.Equals($root, [System.StringComparison]::OrdinalIgnoreCase) -or
            $candidate.StartsWith($root + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)
    }
    catch {
        return $false
    }
}

try {
    $raw = Get-Content -Raw -LiteralPath $StatePath
    $state = $raw | ConvertFrom-Json -DateKind String
}
catch {
    Write-Error "STATE_INVALID: cannot parse JSON: $($_.Exception.Message)"
    exit 1
}

$topRequired = @(
    'schema_version', 'run_id', 'run_status', 'book', 'source',
    'research_cutoff', 'sources', 'sections', 'claims', 'xros',
    'transfer', 'updated_at'
)
foreach ($property in $topRequired) {
    Require-Property -Object $state -Property $property -Context 'state' | Out-Null
}

if ($state.schema_version -ne '1.0.0') { Add-ValidationError 'schema_version must equal 1.0.0' }
$parsedGuid = [guid]::Empty
if (-not [guid]::TryParse([string]$state.run_id, [ref]$parsedGuid)) { Add-ValidationError 'run_id must be a UUID' }
if (@('IN_PROGRESS', 'PARTIAL', 'COMPLETE', 'BLOCKED') -notcontains $state.run_status) { Add-ValidationError 'invalid run_status' }
if (-not (Test-Timestamp $state.updated_at)) { Add-ValidationError 'updated_at must include a numeric UTC offset' }

foreach ($property in @('title', 'author', 'edition', 'language')) {
    if (-not (Require-Property -Object $state.book -Property $property -Context 'book') -or [string]::IsNullOrWhiteSpace([string]$state.book.$property)) {
        Add-ValidationError "book.$property must be nonempty"
    }
}
if ($null -ne $state.book.publication_year -and $state.book.publication_year -isnot [int] -and $state.book.publication_year -isnot [long]) {
    Add-ValidationError 'book.publication_year must be an integer or null'
}

foreach ($property in @('kind', 'canonical_locator', 'sha256', 'final_url', 'etag', 'last_modified')) {
    Require-Property -Object $state.source -Property $property -Context 'source' | Out-Null
}
if (@('LOCAL_FILE', 'PUBLIC_URL') -notcontains $state.source.kind) { Add-ValidationError 'invalid source.kind' }
if ([string]::IsNullOrWhiteSpace([string]$state.source.canonical_locator)) { Add-ValidationError 'source.canonical_locator must be nonempty' }
if (-not (Test-Sha256 $state.source.sha256)) { Add-ValidationError 'source.sha256 must be lowercase SHA-256' }

$dateProbe = [datetime]::MinValue
if (-not [datetime]::TryParseExact([string]$state.research_cutoff.date, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None, [ref]$dateProbe)) {
    Add-ValidationError 'research_cutoff.date must be YYYY-MM-DD'
}
if ([string]::IsNullOrWhiteSpace([string]$state.research_cutoff.timezone)) { Add-ValidationError 'research_cutoff.timezone must be nonempty' }

$sources = @($state.sources)
$sections = @($state.sections)
$claims = @($state.claims)
$xrosEntries = @($state.xros)
Require-Unique -Items $sources -Property 'source_id' -Context 'sources'
Require-Unique -Items $sections -Property 'section_id' -Context 'sections'
Require-Unique -Items $claims -Property 'claim_id' -Context 'claims'
Require-Unique -Items $xrosEntries -Property 'xros_id' -Context 'xros'

$sourceIds = @($sources | ForEach-Object source_id)
$sectionIds = @($sections | ForEach-Object section_id)
$claimIds = @($claims | ForEach-Object claim_id)
$xrosIds = @($xrosEntries | ForEach-Object xros_id)

$sourceTypes = @('BOOK', 'PRIMARY', 'OFFICIAL', 'PEER_REVIEWED', 'SYSTEMATIC_REVIEW', 'CONSENSUS', 'STANDARD', 'SECONDARY')
foreach ($source in $sources) {
    if ($sourceTypes -notcontains $source.source_type) { Add-ValidationError "source '$($source.source_id)' has invalid source_type" }
    if ([string]::IsNullOrWhiteSpace([string]$source.citation)) { Add-ValidationError "source '$($source.source_id)' has empty citation" }
    if ([string]::IsNullOrWhiteSpace([string]$source.locator_or_url)) { Add-ValidationError "source '$($source.source_id)' has empty locator_or_url" }
    if (-not (Test-Timestamp $source.accessed_at)) { Add-ValidationError "source '$($source.source_id)' has invalid accessed_at" }
    if ($null -ne $source.content_sha256 -and -not (Test-Sha256 $source.content_sha256)) { Add-ValidationError "source '$($source.source_id)' has invalid content_sha256" }
}

$sectionKinds = @('FRONT_MATTER', 'PREFACE', 'INTRODUCTION', 'CHAPTER', 'CONCLUSION', 'APPENDIX', 'NOTES', 'OTHER')
$sectionStatuses = @('PENDING', 'READ', 'UNREADABLE', 'MISSING', 'EXCLUDED')
foreach ($section in $sections) {
    if ($sectionKinds -notcontains $section.section_kind) { Add-ValidationError "section '$($section.section_id)' has invalid section_kind" }
    if ($sectionStatuses -notcontains $section.status) { Add-ValidationError "section '$($section.section_id)' has invalid status" }
    if (@('EXCLUDED', 'UNREADABLE', 'MISSING') -contains $section.status -and [string]::IsNullOrWhiteSpace([string]$section.reason)) {
        Add-ValidationError "section '$($section.section_id)' needs a reason"
    }
    if (-not (Test-Timestamp $section.updated_at)) { Add-ValidationError "section '$($section.section_id)' has invalid updated_at" }
    foreach ($claimId in @($section.claim_ids) + @($section.core_claim_ids) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) {
        if ($claimIds -notcontains $claimId) { Add-ValidationError "section '$($section.section_id)' references unknown claim '$claimId'" }
    }
    if ($section.section_kind -eq 'CHAPTER' -and $section.status -eq 'READ' -and @($section.core_claim_ids).Count -eq 0) {
        Add-ValidationError "READ chapter '$($section.section_id)' has no core_claim_ids"
    }
}

$claimTypes = @('FORMAL_PROOF', 'EMPIRICAL_INFERENCE', 'CONCEPTUAL_FRAMEWORK', 'HISTORICAL_INTERPRETATION', 'RHETORIC', 'VALUE_JUDGMENT')
$workflowStatuses = @('IDENTIFIED', 'RESEARCHED', 'XROS_PENDING', 'FINALIZED')
$claimStatuses = @('VERIFIED', 'SUPPORTED', 'DISPUTED_OR_MIXED', 'FALSIFIED', 'UNVERIFIED_OR_INSUFFICIENT_EVIDENCE', 'NON_FALSIFIABLE_OR_INTERPRETIVE')
foreach ($claim in $claims) {
    if ($claimTypes -notcontains $claim.claim_type) { Add-ValidationError "claim '$($claim.claim_id)' has invalid claim_type" }
    if ($workflowStatuses -notcontains $claim.workflow_status) { Add-ValidationError "claim '$($claim.claim_id)' has invalid workflow_status" }
    if ($claim.workflow_status -eq 'FINALIZED' -and $claimStatuses -notcontains $claim.claim_status) { Add-ValidationError "final claim '$($claim.claim_id)' lacks valid claim_status" }
    if ($claim.workflow_status -ne 'FINALIZED' -and $null -ne $claim.claim_status) { Add-ValidationError "non-final claim '$($claim.claim_id)' must have null claim_status" }
    if (@($claim.book_locators).Count -eq 0) { Add-ValidationError "claim '$($claim.claim_id)' has no book locator" }
    foreach ($sectionId in @($claim.core_for_section_ids) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) {
        if ($sectionIds -notcontains $sectionId) { Add-ValidationError "claim '$($claim.claim_id)' references unknown core section '$sectionId'" }
        $section = $sections | Where-Object section_id -eq $sectionId | Select-Object -First 1
        if (@($section.core_claim_ids) -notcontains $claim.claim_id) { Add-ValidationError "claim '$($claim.claim_id)' is not bidirectionally linked to section '$sectionId'" }
    }
    foreach ($sourceId in @($claim.source_ids)) {
        if ($sourceIds -notcontains $sourceId) { Add-ValidationError "claim '$($claim.claim_id)' references unknown source '$sourceId'" }
    }
    if ($null -ne $claim.xros_id -and $xrosIds -notcontains $claim.xros_id) { Add-ValidationError "claim '$($claim.claim_id)' references unknown XROS '$($claim.xros_id)'" }
    if (-not (Test-Timestamp $claim.updated_at)) { Add-ValidationError "claim '$($claim.claim_id)' has invalid updated_at" }
}

foreach ($entry in $xrosEntries) {
    if ($claimIds -notcontains $entry.claim_id) { Add-ValidationError "XROS '$($entry.xros_id)' references unknown claim '$($entry.claim_id)'" }
    if (@('SHARPEN', 'COMPILE', 'RUN', 'REASON', 'NONE') -notcontains $entry.route) { Add-ValidationError "XROS '$($entry.xros_id)' has invalid route" }
    if (@('NOT_CREATED', 'PENDING', 'VALID', 'INVALID', 'BLOCKED') -notcontains $entry.spec_validation) { Add-ValidationError "XROS '$($entry.xros_id)' has invalid spec_validation" }
    if ($null -ne $entry.spec_path -and -not (Test-ProjectContainedPath $entry.spec_path)) { Add-ValidationError "XROS '$($entry.xros_id)' spec path escapes project root" }
    if ($null -ne $entry.verifier_command_fingerprint -and -not (Test-Sha256 $entry.verifier_command_fingerprint)) { Add-ValidationError "XROS '$($entry.xros_id)' has invalid verifier fingerprint" }
    if ($entry.soundness -eq 'none') {
        if ($null -ne $entry.verifier_command -or $null -ne $entry.exit_code -or $entry.pass_condition_result -ne 'NOT_RUN' -or $entry.approval_state -ne 'NOT_REQUIRED') {
            Add-ValidationError "Tier C XROS '$($entry.xros_id)' violates the no-verifier contract"
        }
    }
}

if ($state.transfer.assumption_label -ne 'ASSUMPTION_FOR_TRANSFER') { Add-ValidationError 'transfer assumption label is invalid' }
if (@('CENTRAL', 'CHAPTER', 'ALL_CHAPTERS') -notcontains $state.transfer.mode) { Add-ValidationError 'transfer mode is invalid' }
if (@('PENDING', 'COMPLETE', 'PARTIAL') -notcontains $state.transfer.status) { Add-ValidationError 'transfer status is invalid' }
foreach ($claimId in @($state.transfer.selected_viewpoint_ids)) {
    $claim = $claims | Where-Object claim_id -eq $claimId | Select-Object -First 1
    if ($null -eq $claim -or $claim.workflow_status -ne 'FINALIZED') { Add-ValidationError "transfer viewpoint '$claimId' is not a finalized claim" }
}
$applicationIds = @($state.transfer.applications | ForEach-Object application_id)
if (@($state.transfer.top_five_ids).Count -notin @(0, 5)) { Add-ValidationError 'transfer.top_five_ids must contain zero or five IDs' }
foreach ($applicationId in @($state.transfer.top_five_ids)) {
    if ($applicationIds -notcontains $applicationId) { Add-ValidationError "unknown top-five application '$applicationId'" }
}

if ($errors.Count -gt 0) {
    foreach ($validationError in $errors) { Write-Output "INVALID: $validationError" }
    exit 1
}

$read = @($sections | Where-Object status -eq 'READ').Count
$excluded = @($sections | Where-Object status -eq 'EXCLUDED').Count
$gaps = @($sections | Where-Object { $_.status -in @('UNREADABLE', 'MISSING') }).Count
$chapters = @($sections | Where-Object section_kind -eq 'CHAPTER').Count
$verifiedChapters = @($sections | Where-Object {
    $_.section_kind -eq 'CHAPTER' -and $_.status -eq 'READ' -and
    @($_.core_claim_ids).Count -gt 0 -and
    (@($_.core_claim_ids | Where-Object {
        $candidate = $_
        ($claims | Where-Object claim_id -eq $candidate | Select-Object -First 1).workflow_status -ne 'FINALIZED'
    }).Count -eq 0)
}).Count

Write-Output "VALID: sections=$($sections.Count); read=$read; exclusions=$excluded; gaps=$gaps; chapters=$chapters; verified_chapters=$verifiedChapters; claims=$($claims.Count); xros=$($xrosEntries.Count)"
exit 0
