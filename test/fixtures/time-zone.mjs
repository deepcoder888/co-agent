// v0.53: CO-AGENT shows dates and counts days in the computer's own time zone. Tests whose fixed timestamps stand for
// days and hours in UTC+8 import this first, so they pass on any computer. It must be the file's first import:
// date formatters created when a module loads keep the time zone of that moment.
process.env.TZ = 'Etc/GMT-8';
