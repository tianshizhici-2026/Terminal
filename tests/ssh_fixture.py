"""Loopback-only SSH/SFTP fixture; test credentials, temporary isolated filesystem."""
import os, socket, threading, tempfile, time, pathlib, paramiko
ROOT = pathlib.Path(tempfile.mkdtemp(prefix='mist-sftp-test-'))
KEY = paramiko.RSAKey.generate(2048)
class Handle(paramiko.SFTPHandle):
    def stat(self):
        try: return paramiko.SFTPAttributes.from_stat(os.fstat(self.readfile.fileno()))
        except OSError as e: return paramiko.SFTPServer.convert_errno(e.errno)
class Server(paramiko.ServerInterface):
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if (username,password)==('mist-test','test-only') else paramiko.AUTH_FAILED
    def get_allowed_auths(self, username): return 'password'
    def check_channel_request(self, kind, chanid): return paramiko.OPEN_SUCCEEDED if kind=='session' else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
    def check_channel_pty_request(self,*args): return True
    def check_channel_window_change_request(self,*args): return True
    def check_channel_shell_request(self,channel):
        def echo():
            try:
                channel.send(b'Mist SSH fixture ready\r\n')
                while True:
                    data=channel.recv(32768)
                    if not data: break
                    if b"__TEST_DROP_TRANSPORT__" in data:
                        channel.get_transport().close(); break
                    if b"__TEST_CLOSE_SHELL__" in data:
                        channel.close(); break
                    channel.send(data)
            except Exception: pass
        threading.Thread(target=echo,daemon=True).start(); return True
class Files(paramiko.SFTPServerInterface):
    def local(self,path):
        candidate=(ROOT / path.lstrip('/')).resolve()
        if not candidate.is_relative_to(ROOT): raise OSError('outside fixture')
        return candidate
    def canonicalize(self,path): return '/' + str(pathlib.PurePosixPath('/'+path).relative_to('/')) if path!='.' else '/'
    def list_folder(self,path):
        try:
            result=[]
            for p in self.local(path).iterdir():
                a=paramiko.SFTPAttributes.from_stat(p.stat());a.filename=p.name;result.append(a)
            return result
        except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
    def stat(self,path):
        try:return paramiko.SFTPAttributes.from_stat(self.local(path).stat())
        except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
    lstat=stat
    def open(self,path,flags,attr):
        try:
            fd=os.open(self.local(path),flags|getattr(os,'O_BINARY',0),0o600)
            f=os.fdopen(fd,'r+b' if flags & os.O_RDWR else 'wb' if flags & os.O_WRONLY else 'rb')
            h=Handle(flags);h.readfile=f;h.writefile=f;return h
        except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
    def mkdir(self,path,attr):
        try:self.local(path).mkdir();return paramiko.SFTP_OK
        except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
    def rename(self,old,new):
        try:self.local(old).rename(self.local(new));return paramiko.SFTP_OK
        except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
    def remove(self,path):
        try:self.local(path).unlink();return paramiko.SFTP_OK
        except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
    def rmdir(self,path):
        try:self.local(path).rmdir();return paramiko.SFTP_OK
        except OSError as e:return paramiko.SFTPServer.convert_errno(e.errno)
def connection(sock):
    transport=paramiko.Transport(sock);transport.add_server_key(KEY)
    transport.set_subsystem_handler('sftp',paramiko.SFTPServer,Files)
    try:
        transport.start_server(server=Server())
        while transport.is_active():time.sleep(.1)
    finally:transport.close()
sock=socket.socket();sock.bind(('127.0.0.1',22992));sock.listen(10)
print('SSH fixture listening on 127.0.0.1:22992',flush=True)
while True:
    client,_=sock.accept();threading.Thread(target=connection,args=(client,),daemon=True).start()
