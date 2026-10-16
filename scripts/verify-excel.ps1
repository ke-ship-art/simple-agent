param([string]$Source = (Join-Path $PSScriptRoot '..\test-results\reliability-cache.xlsx'))
$ErrorActionPreference = 'Stop'
$fixture = (Resolve-Path -LiteralPath $Source).Path
if (-not ([IO.Path]::GetFileName($fixture) -eq 'reliability-cache.xlsx')) { throw 'Only the generated reliability-cache.xlsx test fixture is supported' }
$result = Join-Path ([IO.Path]::GetDirectoryName($fixture)) 'reliability-excel-recalculated.xlsx'
Copy-Item -LiteralPath $fixture -Destination $result
$excel = $null; $book = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.Visible = $false; $excel.DisplayAlerts = $false; $excel.AutomationSecurity = 3
  $book = $excel.Workbooks.Open($result, 0, $false)
  $excel.CalculateFullRebuild()
  $values = [ordered]@{ ExcelVersion=$excel.Version; Direct=$book.Worksheets.Item('Sheet1').Range('B1').Value2; Chain=$book.Worksheets.Item('Sheet1').Range('C1').Value2; CrossSheet=$book.Worksheets.Item('第二表').Range('A1').Value2; Independent=$book.Worksheets.Item('Sheet1').Range('D1').Value2 }
  if ($values.Direct -ne 8 -or $values.Chain -ne 9 -or $values.CrossSheet -ne 18 -or $values.Independent -ne 101) { throw 'Excel recalculation mismatch' }
  $book.Save(); $values | ConvertTo-Json
} finally {
  if ($null -ne $book) { $book.Close($false); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($book) }
  if ($null -ne $excel) { $excel.Quit(); [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($excel) }
}
