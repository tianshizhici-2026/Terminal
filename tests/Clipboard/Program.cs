using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;
using Mist.Terminal;

class Program
{
    [STAThread] static int Main(string[] args)
    {
        var app=new Application();var window=new Window{ShowInTaskbar=false,Width=100,Height=100,WindowStyle=WindowStyle.None};
        IntPtr handle=new WindowInteropHelper(window).EnsureHandle();
        if(args.Contains("--hold"))
        {
            if(!OpenClipboard(handle))return 2;
            Console.WriteLine("READY");Console.Out.Flush();Thread.Sleep(175);CloseClipboard();return 0;
        }
        int result=0;
        app.Dispatcher.InvokeAsync(async()=>
        {
            string? previous=null;bool captured=false;
            try
            {
                previous=await ClipboardAccess.ReadAsync(handle);captured=true;
                using var child=Process.Start(new ProcessStartInfo(Environment.ProcessPath!,"--hold"){UseShellExecute=false,RedirectStandardOutput=true,CreateNoWindow=true})!;
                if(await child.StandardOutput.ReadLineAsync()! != "READY")throw new Exception("Clipboard lock fixture failed");
                int ticks=0;var timer=new DispatcherTimer{Interval=TimeSpan.FromMilliseconds(10)};timer.Tick+=(_,_)=>ticks++;timer.Start();
                await ClipboardAccess.WriteAsync(handle,"Terminal 中文 clipboard test");timer.Stop();
                if(ticks<2)throw new Exception("Clipboard retry blocked dispatcher");
                if(await ClipboardAccess.ReadAsync(handle)!="Terminal 中文 clipboard test")throw new Exception("Clipboard Unicode round-trip failed");
                await child.WaitForExitAsync();
                Console.WriteLine("PASS clipboard contention retries without blocking UI; Unicode copy/paste");
            }
            catch(Exception e){Console.WriteLine(e.Message);result=1;}
            finally{if(captured)await ClipboardAccess.WriteAsync(handle,previous!);window.Close();app.Shutdown();}
        });
        app.Run();return result;
    }
    [DllImport("user32.dll")]static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")]static extern bool CloseClipboard();
}
