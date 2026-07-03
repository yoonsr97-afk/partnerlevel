param(
  [Parameter(Mandatory=$true)][string]$InputPath,
  [Parameter(Mandatory=$true)][string]$OutputPath
)
$ErrorActionPreference = "Stop"

# Quit()만으로는 COM 참조가 남아있어 WINWORD.EXE 프로세스가 백그라운드에 계속 떠있는
# 채로 남는 경우가 있다(매 변환마다 좀비 프로세스가 누적됨). 문서/Application 객체를
# 명시적으로 ReleaseComObject + GC로 정리해야 실제로 프로세스가 종료된다.
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$doc = $null
try {
  $doc = $word.Documents.Open($InputPath, $false, $true)
  $doc.SaveAs([ref]$OutputPath, [ref]17) # wdFormatPDF
} finally {
  if ($doc) {
    $doc.Close([ref]$false)
    [System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
  }
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
  [System.GC]::Collect()
  [System.GC]::WaitForPendingFinalizers()
}
