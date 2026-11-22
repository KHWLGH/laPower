# SPDX-License-Identifier: GPL-3.0-only
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw -LiteralPath (Join-Path $repo 'package.json') | ConvertFrom-Json).version
if ($version -cnotmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') {
    throw "Invalid laPower version: $version"
}

$release = Join-Path $repo 'target/x86_64-pc-windows-msvc/release'
$exe = Get-Item -LiteralPath (Join-Path $release 'lapower.exe')
if ($exe.PSIsContainer -or $exe.Length -eq 0) { throw 'Expected the compiled laPower executable.' }
$bundle = Join-Path $release 'bundle/portable'
$null = New-Item -ItemType Directory -Force -Path $bundle
$zip = Join-Path $bundle "laPower_${version}_windows-x64_portable.zip"

$stage = New-Item -ItemType Directory -Path (Join-Path $bundle ([guid]::NewGuid().ToString()))
try {
    Copy-Item -LiteralPath $exe.FullName -Destination (Join-Path $stage.FullName 'laPower.exe')
    Copy-Item -LiteralPath (Join-Path $repo 'LICENSE'), (Join-Path $repo 'LICENSE.LGPL-3.0'), (Join-Path $repo 'COPYRIGHT') -Destination $stage.FullName
    $readme = @(
        'Windows x64 portable edition / Windows x64 免安装版',
        '',
        'Extract all files, then double-click laPower.exe.',
        'Microsoft Edge WebView2 Runtime must already be available on the system.',
        'App settings and cache use the existing Windows user data directories.',
        '',
        '解压全部文件后，双击 laPower.exe 启动。',
        '运行环境需要 Microsoft Edge WebView2 Runtime。',
        '应用设置和缓存沿用 Windows 用户数据目录。'
    ) -join [Environment]::NewLine
    Set-Content -LiteralPath (Join-Path $stage.FullName 'README.txt') -Value $readme -Encoding utf8

    $archive = Join-Path $stage.FullName 'verified.zip'
    $files = @(Get-ChildItem -File -LiteralPath $stage.FullName)
    Compress-Archive -LiteralPath $files.FullName -DestinationPath $archive -CompressionLevel Optimal
    $contents = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        $entry = $contents.GetEntry('laPower.exe')
        if ($contents.Entries.Count -ne $files.Count -or $null -eq $entry -or $entry.Length -ne $exe.Length) {
            throw 'The portable ZIP does not contain the expected Windows application and support files.'
        }
        $stream = $entry.Open()
        try {
            if ((Get-FileHash -InputStream $stream).Hash -ne (Get-FileHash -LiteralPath $exe.FullName).Hash) {
                throw 'The portable ZIP executable differs from the application build.'
            }
        } finally { $stream.Dispose() }
    } finally { $contents.Dispose() }
    Move-Item -LiteralPath $archive -Destination $zip -Force
    Write-Output $zip
} finally {
    Get-ChildItem -File -LiteralPath $stage.FullName | Remove-Item -Force
    Remove-Item -LiteralPath $stage.FullName
}
