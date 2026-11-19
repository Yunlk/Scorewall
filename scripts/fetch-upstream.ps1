# 拉 ICPC Tools 上游源码（只取需要的目录，不拉整个仓库）
#
# 用法：
#   pwsh scripts/fetch-upstream.ps1            # 默认拉 v2.6.1331（和我们手上的 jar 对齐）
#   pwsh scripts/fetch-upstream.ps1 v2.7.1470  # 指定别的 tag
#
# 产物落在 vendor/icpctools/（已 gitignore），可以直接 grep 找常数、比对渲染逻辑。

param(
    [string]$Ref = "v2.6.1331",
    [string]$Dest = "vendor/icpctools"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dest = Join-Path $root $Dest

if (Test-Path $dest) {
    Write-Host "已存在：$dest（删掉重来请先 Remove-Item -Recurse）"
    exit 0
}

New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null

# 只取源码目录，仓库里有大量图片/示例题，整包 140MB+
Write-Host "拉取 $Ref ..."
git clone --depth 1 --filter=blob:none --sparse --branch $Ref `
    https://github.com/icpctools/icpctools.git $dest

Push-Location $dest
try {
    git sparse-checkout set `
        PresContest/src `
        ContestModel/src `
        PresCore/src `
        PresAdmin/src
    Write-Host ""
    Write-Host "OK -> $dest"
    Write-Host "常用位置："
    Write-Host "  PresContest/src/org/icpc/tools/presentation/contest/internal/scoreboard/"
    Write-Host "  PresContest/src/org/icpc/tools/presentation/TitledPresentation.java"
    Write-Host "  ContestModel/src/org/icpc/tools/contest/model/internal/"
}
finally {
    Pop-Location
}
