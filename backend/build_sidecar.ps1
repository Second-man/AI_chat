$ErrorActionPreference = 'Stop'

# Build the Python/LangChain service into a folder that Tauri ships inside the
# Windows installer.  The end user does not need Python, pip, or a virtualenv.
$projectRoot = Split-Path -Parent $PSScriptRoot
$python = Join-Path (Split-Path -Parent $projectRoot) '.venv\python.exe'
$resourceRoot = Join-Path $projectRoot 'src-tauri\resources'
$buildRoot = Join-Path $PSScriptRoot 'build'
$executable = Join-Path $resourceRoot 'echomate-api\echomate-api.exe'

if (-not (Test-Path -LiteralPath $python)) {
  throw "Python environment not found: $python"
}

if ((Test-Path -LiteralPath $executable) -and ((Get-Item -LiteralPath $executable).LastWriteTime -ge (Get-Item -LiteralPath (Join-Path $PSScriptRoot 'main.py')).LastWriteTime)) {
  Write-Host "Using existing EchoMate API sidecar: $executable"
  exit 0
}

& $python -m PyInstaller `
  --noconfirm `
  --clean `
  --onedir `
  --name echomate-api `
  --distpath $resourceRoot `
  --workpath $buildRoot `
  --specpath $buildRoot `
  --collect-all chromadb `
  --collect-all sentence_transformers `
  --collect-all onnxruntime `
  (Join-Path $PSScriptRoot 'main.py')

if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE" }

# Keep the resource directory represented in Git after PyInstaller replaces its
# contents. The executable itself is intentionally ignored because it is large.
New-Item -ItemType File -Path (Join-Path $resourceRoot 'echomate-api\.gitkeep') -Force | Out-Null
