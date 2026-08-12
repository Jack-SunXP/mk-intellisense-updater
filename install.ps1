# Install the mk-intellisense-updater VS Code extension from source.
# Run this script once after cloning the repository.
#
# Requirements: Node.js (npm) must be in PATH.

$ErrorActionPreference = "Stop"
$extDir = "$PSScriptRoot"

Push-Location $extDir
try {
    # Install vsce if not already available
    if (-not (Get-Command vsce -ErrorAction SilentlyContinue)) {
        Write-Host "Installing @vscode/vsce..." -ForegroundColor Cyan
        npm install -g @vscode/vsce
    }

    # Package the extension
    Write-Host "Packaging extension..." -ForegroundColor Cyan
    vsce package --no-dependencies --allow-missing-repository 2>&1 | Out-Null

    # Install the latest produced vsix
    $vsix = Get-ChildItem "$extDir\*.vsix" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $vsix) {
        Write-Error "No .vsix file found after packaging."
    }

    Write-Host "Installing $($vsix.Name)..." -ForegroundColor Cyan
    code --install-extension $vsix.FullName

    Write-Host "Done. Restart VS Code if the extension does not appear immediately." -ForegroundColor Green
}
finally {
    Pop-Location
}
