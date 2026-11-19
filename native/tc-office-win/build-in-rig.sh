#!/usr/bin/env bash
# Builds tc-office in the Windows rig (docs/agents/windows-vm.md) with the csc.exe Windows carries:
# tc-office.exe as shipped, and tc-office-recorded.exe with the recorded COM surface compiled in for
# the tests (src/main/server/work/office/com/rig.test.ts). Leaves both in C:\Users\tcuser\<dir>.
# Usage: native/tc-office-win/build-in-rig.sh [dir]   (default m44)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
vm="$here/../../scripts/win-vm"
dir=${1:-m44}
"$vm/ssh.sh" "if not exist $dir mkdir $dir" >/dev/null
"$vm/scp.sh" "$here/TcOffice.cs" "$here/RecordedCom.cs" "guest:$dir/" >/dev/null
csc='C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
refs='/r:System.Core.dll /r:System.Web.Extensions.dll /r:System.Windows.Forms.dll'
"$vm/ssh.sh" "cd $dir && $csc /nologo /optimize /target:exe $refs /out:tc-office.exe TcOffice.cs && $csc /nologo /optimize /target:exe /define:RECORDED $refs /out:tc-office-recorded.exe TcOffice.cs RecordedCom.cs"
