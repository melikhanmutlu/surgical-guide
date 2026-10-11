#!/bin/sh
# Tests of the touching-bone separation (browser module and pipeline) and of the production STL against the browser
# preview; synthetic volumes and the built-in sample only, no patient data.
#   sh tests/run_all.sh
cd "$(dirname "$0")/.." || exit 1
node tests/test_separate.mjs || rc=1
python3 tests/test_bones.py || rc=1
python3 tests/test_pipeline.py || rc=1
python3 tests/test_server_preview.py || rc=1
exit ${rc:-0}
