根据你的需求和具体的 IP 配置，我们将在你的本机（192.168.0.101 和 10.30.16.72）上设置一个端口转发规则，用生僻端口（例如 12345）将 10.30.160.6 网段的 SSH 流量转发到 192.169.0.100 的 22 端口。

步骤
1. 设置端口转发
在你的本机上，使用 netsh 工具设置端口转发：

cmd
复制代码
netsh interface portproxy add v4tov4 listenaddress=10.30.16.72 listenport=12345 connectaddress=192.169.0.100 connectport=22
参数说明
listenaddress=10.30.16.72：本机在 10.30.x.x 网段的 IP。
listenport=12345：监听的生僻端口。
connectaddress=192.169.0.100：目标测试机的 IP。
connectport=22：目标测试机的 SSH 服务端口。
2. 验证端口转发规则
查看当前端口转发规则：

cmd
复制代码
netsh interface portproxy show all
你应该看到类似以下输出：

less
复制代码
Listen on IPv4:             Connect to IPv4:
Address         Port        Address         Port
--------------- ----------  --------------- ----------
10.30.16.72     12345       192.169.0.100   22
3. 配置 Windows 防火墙
确保防火墙允许来自 10.30.160.6 的流量访问本机的 12345 端口：

执行以下命令：

cmd
复制代码
netsh advfirewall firewall add rule name="SSH Proxy 12345" dir=in action=allow protocol=TCP localport=12345
4. 测试 SSH
在 10.30.160.6 上，通过指定生僻端口连接：

bash
复制代码
ssh rickliu@10.30.16.72 -p 12345
此命令会通过你的本机转发到 192.169.0.100 的 SSH 服务。

5. 删除规则（可选）
如果需要删除端口转发规则或调整端口，可以用以下命令：

cmd
复制代码
netsh interface portproxy delete v4tov4 listenaddress=10.30.16.72 listenport=12345
注意事项
保持 IP 转发启用： 如果转发失败，请检查 IP 转发是否启用（参考之前启用 IP 转发的步骤）。

保持端口占用检查： 确保 12345 端口未被其他服务占用。使用 netstat 检查：

cmd
复制代码
netstat -ano | find "12345"
通过上述配置，你的本机会监听 12345 端口，将 SSH 请求从 10.30.16.72 转发到测试机 192.169.0.100 的 22 端口。