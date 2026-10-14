using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Shell;
using System.Windows.Threading;
using Mist.Terminal;
class Program
{
 [STAThread] static int Main(string[] args)
 {
  foreach(var (monitor,work) in new[]{
   (R(0,0,1920,1080),R(0,0,1920,1032)),
   (R(-2560,-300,0,1140),R(-2560,-300,0,1080)),
   (R(1920,0,5760,2160),R(2016,0,5760,2160)),
   (R(0,-2160,3840,0),R(0,-2088,3840,0))})
  {
   var m=new WindowBounds.MinMaxInfo();WindowBounds.ApplyWorkArea(ref m,monitor,work);
   if(m.MaxPosition.X+monitor.Left!=work.Left||m.MaxPosition.Y+monitor.Top!=work.Top||m.MaxSize.X!=work.Right-work.Left||m.MaxSize.Y!=work.Bottom-work.Top)throw new Exception("Incorrect work area");
  }
  Console.WriteLine("PASS bottom/top/left taskbars, negative monitor coordinates and physical-pixel geometry");
  var app=new Application();var window=new Window{Title="Window bounds integration test",Width=900,Height=600,MinWidth=760,MinHeight=480,WindowStyle=WindowStyle.None,ResizeMode=ResizeMode.CanResize,ShowInTaskbar=false,Background=System.Windows.Media.Brushes.DimGray};
  WindowChrome.SetWindowChrome(window,new WindowChrome{CaptionHeight=42,ResizeBorderThickness=new Thickness(6),GlassFrameThickness=new Thickness(0),UseAeroCaptionButtons=false});
  if(!args.Contains("--baseline"))WindowBounds.Attach(window);
  int result=0;
  window.Loaded+=async(_,_)=>{
   try{
    window.WindowState=WindowState.Maximized;
    await window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.ApplicationIdle);
    var handle=new WindowInteropHelper(window).Handle;var monitor=WindowBounds.GetMonitor(handle)!.Value;
    GetWindowRect(handle,out var actual);var work=monitor.Work;
    Console.WriteLine($"Work area: {work.Left},{work.Top}–{work.Right},{work.Bottom}; window: {actual.Left},{actual.Top}–{actual.Right},{actual.Bottom}");
    if(actual.Left!=work.Left||actual.Top!=work.Top||actual.Right!=work.Right||actual.Bottom!=work.Bottom)throw new Exception("Maximized window does not equal monitor work area");
    window.WindowState=WindowState.Normal;await window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.ApplicationIdle);
    if(Math.Abs(window.Width-900)>2||Math.Abs(window.Height-600)>2)throw new Exception("Restore size changed");
    window.WindowState=WindowState.Maximized;await window.Dispatcher.InvokeAsync(()=>{},DispatcherPriority.ApplicationIdle);
    GetWindowRect(handle,out actual);if(actual.Bottom!=work.Bottom)throw new Exception("Second maximize failed");
    Console.WriteLine("PASS native maximize, restore, and re-maximize stay above taskbar");
   }catch(Exception e){Console.WriteLine(e.Message);result=1;}finally{window.Close();}
  };
  app.Run(window);return result;
 }
 static WindowBounds.Rect R(int l,int t,int r,int b)=>new(){Left=l,Top=t,Right=r,Bottom=b};
 [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr hwnd,out WindowBounds.Rect rect);
}
