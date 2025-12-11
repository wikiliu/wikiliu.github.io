Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' ProxyEnable -Value 1
Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' ProxyServer -Value '127.0.0.1:7890'

netsh winhttp import proxy source=ie

Stop-Process -Name WinStore.App -Force
Start-Process "ms-windows-store:"

Invoke-WebRequest https://storeedgefd.dsx.mp.microsoft.com
