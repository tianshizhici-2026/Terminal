using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using System.IO;
using Mist.Terminal;
class Program
{
 [STAThread] static int Main()
 {
  Directory.CreateDirectory("artifacts");
  var app=new Application{ShutdownMode=ShutdownMode.OnExplicitShutdown};
  int failures=0;
  void Check(string title, bool accept, bool confirmation=true, bool screenshot=false)
  {
   var dialog=new ConfirmWindow(title,confirmation?"首次连接 server.example:22\n核对指纹后，信任并保存此服务器。":"服务器指纹已改变，连接已阻止。",confirmation?"信任并连接":"知道了","SHA256:AbCdEf0123456789-example-fingerprint",confirmation){ShowActivated=false};
   dialog.Loaded+=(_,_)=>dialog.Dispatcher.BeginInvoke(DispatcherPriority.ApplicationIdle,()=>{
    try{
     if(dialog.WindowStyle!=WindowStyle.None||dialog.ShowInTaskbar)throw new Exception("Default chrome or extra taskbar entry");
     if(((TextBox)dialog.FindName("Detail")).Text.Length==0)throw new Exception("Missing fingerprint");
     if(screenshot){var visual=(FrameworkElement)dialog.Content;var image=new RenderTargetBitmap((int)(visual.ActualWidth+visual.Margin.Left+visual.Margin.Right),(int)(visual.ActualHeight+visual.Margin.Top+visual.Margin.Bottom),96,96,PixelFormats.Pbgra32);image.Render(visual);var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(image));using var stream=File.Create("artifacts/confirmation-preview.png");encoder.Save(stream);}
     ((Button)dialog.FindName(accept?"AcceptButton":"CancelButton")).RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    }catch(Exception e){Console.WriteLine(e.Message);failures++;dialog.Close();}
   });
   bool result=dialog.ShowDialog()==true;
   if(result!=accept){Console.WriteLine("FAIL dialog result");failures++;}else Console.WriteLine("PASS "+title+": "+(accept?"accept":"cancel"));
  }
  Check("信任此服务器？",true,screenshot:true);Check("退出 Terminal？",false);Check("退出 Terminal？",true);Check("服务器身份已更改",true,false);
  app.Shutdown();return failures;
 }
}
