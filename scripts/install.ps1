$ErrorActionPreference = 'Stop'
if ([int]((node -p "process.versions.node.split('.')[0]") ) -lt 20) { throw '需要 Node.js 20 或更高版本' }
if (-not (Get-Command restic -ErrorAction SilentlyContinue)) { throw '请先从 https://restic.net 安装 restic' }
if (-not (Get-Command rclone -ErrorAction SilentlyContinue)) { throw '请先从 https://rclone.org 安装 rclone' }
$dir = Join-Path $env:APPDATA 'agentsync'; New-Item -ItemType Directory -Force -Path $dir | Out-Null
Write-Host '依赖检查完成。运行 ag-box sessions init <项目路径> 开始。'
