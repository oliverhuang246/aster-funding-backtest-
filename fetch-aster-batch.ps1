param(
  [Parameter(Mandatory = $true)]
  [string]$Kind,

  [Parameter(Mandatory = $true)]
  [string]$Symbols,

  [string]$StartTime = "",

  [string]$EndTime = "",

  [string]$Limit = "8",

  [string]$PauseMs = "0"
)

$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$symbolList = $Symbols -split ',' | Where-Object { $_ -ne '' }
$result = @{}

foreach ($symbol in $symbolList) {
  try {
    if ($Kind -eq 'funding') {
      $url = "https://fapi.asterdex.com/fapi/v1/fundingRate?symbol=$symbol&limit=$Limit"
      if ($StartTime -ne "") {
        $url = "$url&startTime=$StartTime"
      }
      if ($EndTime -ne "") {
        $url = "$url&endTime=$EndTime"
      }
    } elseif ($Kind -eq 'openInterest') {
      $url = "https://fapi.asterdex.com/fapi/v1/openInterest?symbol=$symbol"
    } else {
      throw "Unknown batch kind: $Kind"
    }

    $content = Invoke-WebRequest -Uri $url -UseBasicParsing | Select-Object -ExpandProperty Content
    $result[$symbol] = $content | ConvertFrom-Json
    $pause = 0
    if ([int]::TryParse($PauseMs, [ref]$pause) -and $pause -gt 0) {
      Start-Sleep -Milliseconds $pause
    }
  } catch {
    $result[$symbol] = $null
  }
}

$result | ConvertTo-Json -Depth 8 -Compress
