param(
  [Parameter(Mandatory = $true)]
  [string]$Url
)

$ProgressPreference = 'SilentlyContinue'
Invoke-WebRequest -Uri $Url -UseBasicParsing | Select-Object -ExpandProperty Content
