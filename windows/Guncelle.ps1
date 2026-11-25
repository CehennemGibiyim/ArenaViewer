#Requires -Version 5.1
param(
    [Parameter(Mandatory = $true)]
    [string]$Root,
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'
$repo = 'CehennemGibiyim/ArenaViewer'
$releaseApi = "https://api.github.com/repos/$repo/releases/latest"
$installRoot = Join-Path $env:LOCALAPPDATA 'ATIKVIEWER'

function Test-PortListening([int]$PortNo) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $client.Connect('127.0.0.1', $PortNo)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-TrustedReleaseAsset([object[]]$Assets, [string]$Name, [string]$Tag) {
    $asset = $Assets | Where-Object { $_.name -eq $Name } | Select-Object -First 1
    if (-not $asset) { return $null }

    $expectedUrl = "https://github.com/$repo/releases/download/$Tag/$Name"
    if ($asset.browser_download_url -ne $expectedUrl) {
        throw "Yayın varlığının indirme adresi beklenen GitHub adresiyle eşleşmiyor: $Name"
    }
    return $expectedUrl
}

try {
    $rootPath = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
    $installedPath = [System.IO.Path]::GetFullPath($installRoot).TrimEnd('\')
    if (-not [string]::Equals($rootPath, $installedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        Write-Host 'Geliştirme/kaynak kurulumunda otomatik güncelleme atlandı.' -ForegroundColor DarkGray
        return $false
    }

    if ((Test-PortListening $Port) -or (Test-PortListening 8787)) {
        Write-Host 'Uygulama veya AI worker çalışıyor; dosyalar değiştirilmeden güncelleme atlandı.' -ForegroundColor Yellow
        return $false
    }

    $package = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
    $currentVersion = [version]$package.version
} catch {
    throw "Kurulu sürüm bilgisi okunamadı: $($_.Exception.Message)"
}

try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $release = Invoke-RestMethod -Uri $releaseApi -Headers @{
        Accept = 'application/vnd.github+json'
        'User-Agent' = 'ATIKVIEWER-Updater'
    } -TimeoutSec 12
} catch {
    Write-Host "Güncelleme sunucusuna ulaşılamadı; mevcut sürümle devam ediliyor. $($_.Exception.Message)" -ForegroundColor Yellow
    return $false
}

if ($release.draft -or $release.prerelease -or $release.tag_name -notmatch '^v(\d+\.\d+\.\d+)$') {
    Write-Host 'Son kararlı yayın sürüm etiketi geçersiz; güncelleme atlandı.' -ForegroundColor Yellow
    return $false
}

$latestVersion = [version]$Matches[1]
if ($latestVersion -le $currentVersion) {
    Write-Host "Uygulama güncel (v$currentVersion)." -ForegroundColor DarkGray
    return $false
}

$tag = $release.tag_name
$installerName = "ATIKVIEWER-$latestVersion-Setup.exe"
try {
    $installerUrl = Get-TrustedReleaseAsset $release.assets $installerName $tag
    $checksumsUrl = Get-TrustedReleaseAsset $release.assets 'SHA256SUMS' $tag
    if (-not $installerUrl -or -not $checksumsUrl) {
        Write-Host "v$latestVersion yayını kurulum dosyası veya SHA256SUMS içermiyor; güncelleme atlandı." -ForegroundColor Yellow
        return $false
    }

    $tempDir = Join-Path $env:TEMP "atikviewer-update-$latestVersion-$PID"
    New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
    $installerPath = Join-Path $tempDir $installerName
    $checksumsPath = Join-Path $tempDir 'SHA256SUMS'
    Invoke-WebRequest -Uri $installerUrl -OutFile $installerPath -UseBasicParsing -TimeoutSec 120
    Invoke-WebRequest -Uri $checksumsUrl -OutFile $checksumsPath -UseBasicParsing -TimeoutSec 30

    $checksumPattern = '(?im)^(?<hash>[0-9a-f]{64})\s+\*?' + [regex]::Escape($installerName) + '\s*$'
    $checksumMatch = [regex]::Match((Get-Content $checksumsPath -Raw), $checksumPattern)
    if (-not $checksumMatch.Success) {
        throw 'SHA256SUMS dosyasında kurulum dosyasının özeti bulunamadı.'
    }

    $actualHash = (Get-FileHash -Path $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $checksumMatch.Groups['hash'].Value.ToLowerInvariant()) {
        throw 'Kurulum dosyasının SHA-256 doğrulaması başarısız oldu.'
    }
} catch {
    if ($tempDir -and (Test-Path -LiteralPath $tempDir)) {
        Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host "Güncelleme indirilemedi veya doğrulanamadı; mevcut sürümle devam ediliyor. $($_.Exception.Message)" -ForegroundColor Yellow
    return $false
}

Write-Host "v$latestVersion bulundu; imzası SHA-256 ile doğrulandı. Güncelleme kuruluyor..." -ForegroundColor Cyan
try {
    $installer = Start-Process -FilePath $installerPath -ArgumentList @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'
    ) -Wait -PassThru
} finally {
    Remove-Item -LiteralPath $tempDir -Recurse -Force -ErrorAction SilentlyContinue
}
if ($installer.ExitCode -ne 0) {
    throw "Kurulum paketi başarısız oldu (çıkış kodu $($installer.ExitCode))."
}

$installedPackage = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
if ($installedPackage.version -ne $latestVersion.ToString()) {
    throw "Kurulumdan sonra sürüm v$($installedPackage.version) oldu; v$latestVersion bekleniyordu."
}

Push-Location $Root
$previousDatabaseUrl = $env:DATABASE_URL
try {
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm ci başarısız oldu (çıkış kodu $LASTEXITCODE)." }

    # Build only imports the DB client; it must also work on installs without PostgreSQL.
    $env:DATABASE_URL = 'postgresql://build:build@127.0.0.1:5432/atikviewer'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build başarısız oldu (çıkış kodu $LASTEXITCODE)." }
} finally {
    if ($null -eq $previousDatabaseUrl) {
        Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
    } else {
        $env:DATABASE_URL = $previousDatabaseUrl
    }
    Pop-Location
}

Write-Host "ATIKVIEWER v$latestVersion güncellendi." -ForegroundColor Green
return $true
