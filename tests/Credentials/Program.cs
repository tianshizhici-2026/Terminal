using Mist.Terminal;
using System.Text.Json;
using System.Text.Json.Nodes;
var path=Path.Combine(Path.GetTempPath(),"terminal-credential-test-"+Guid.NewGuid()+".json");
var store=new SettingsStore(path);
const string secret="test-only-中文-!pass";
JsonObject Request(bool? remember, string password=secret, string host="server.example",string key="") {
 var request=new JsonObject{["fontSize"]=14,["profiles"]=new JsonArray(new JsonObject{["id"]="test",["name"]="test",["host"]=host,["port"]=22,["username"]="user",["keyPath"]=key})};
 if(remember.HasValue)request["credential"]=new JsonObject{["id"]="test",["rememberPassword"]=remember.Value,["password"]=password};
 return request;
}
void Save(JsonObject r)=>store.Save(JsonSerializer.SerializeToElement(r));
void Check(bool value,string message){if(!value)throw new Exception(message);Console.WriteLine("PASS "+message);}
try {
 Save(Request(false));Check(!File.ReadAllText(path).Contains(secret)&&store.GetPassword("test")=="","default opt-out does not store password");
 Save(Request(true));Check(!File.ReadAllText(path).Contains(secret)&&File.ReadAllText(path).Contains("passwordCipher"),"disk contains ciphertext only");
 Check(new SettingsStore(path).GetPassword("test")==secret,"DPAPI decrypts after reloading store");
 var ui=store.LoadForUi();Check(!ui.ToJsonString().Contains("passwordCipher")&&!ui.ToJsonString().Contains(secret)&&ui["profiles"]![0]!["rememberPassword"]!.GetValue<bool>(),"profile listing exposes only saved flag");
 Save(Request(null));Check(store.GetPassword("test")==secret,"ordinary settings save preserves encrypted password");
 var sized=Request(null);sized["sftpWidth"]=680;Save(sized);
 Check(new SettingsStore(path).LoadForUi()["sftpWidth"]!.GetValue<int>()==680&&store.GetPassword("test")==secret,"SFTP width persists without changing saved password");
 sized["sftpWidth"]=9999;Save(sized);Check(store.LoadForUi()["sftpWidth"]!.GetValue<int>()==1200,"SFTP width is bounded");
 var extended=Request(null);extended["fontFamily"]="SimHei";extended["profiles"]![0]!["lastUsed"]=123456789;
 extended["snippets"]=new JsonArray(new JsonObject{["id"]="code-1",["title"]="中文代码",["code"]="pwd\nls -la"});Save(extended);
 var restored=new SettingsStore(path).LoadForUi();
 Check(restored["fontFamily"]!.GetValue<string>()=="SimHei"&&restored["snippets"]![0]!["code"]!.GetValue<string>()=="pwd\nls -la"&&restored["profiles"]![0]!["lastUsed"]!.GetValue<long>()==123456789,"font, snippets and recent connection persist");
 Save(Request(null));Check(store.LoadForUi()["snippets"]!.AsArray().Count==1&&store.GetPassword("test")==secret,"legacy settings update preserves snippets and password");
 Save(Request(true,"replacement"));Check(store.GetPassword("test")=="replacement","password replacement persists");
 Save(Request(false));Check(store.GetPassword("test")==""&&!File.ReadAllText(path).Contains("passwordCipher"),"unchecking removes saved password");
 Save(Request(true));Save(Request(null,host:"other.example"));Check(store.GetPassword("test")=="","host change cannot inherit password");
 Save(Request(true));Save(Request(null,key:"private-key"));Check(store.GetPassword("test")=="","private-key authentication removes password");
 Save(Request(true));var corrupt=JsonNode.Parse(File.ReadAllText(path))!;corrupt["profiles"]![0]!["passwordCipher"]="invalid";File.WriteAllText(path,corrupt.ToJsonString());
 try{store.GetPassword("test");throw new Exception("Corrupt password accepted");}catch(InvalidOperationException){Console.WriteLine("PASS unreadable password reports recoverable error");}
 Save(new JsonObject{["profiles"]=new JsonArray()});Check(!File.ReadAllText(path).Contains("passwordCipher"),"deleting profile removes saved password");
} finally {File.Delete(path);}
