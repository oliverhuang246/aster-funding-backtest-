param(
  [Parameter(Mandatory = $true)]
  [string]$Url
)

$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Invoke-WebRequest -Uri $Url -UseBasicParsing | Select-Object -ExpandProperty Content
