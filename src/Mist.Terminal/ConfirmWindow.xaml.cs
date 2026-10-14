using System.Windows;
using System.Windows.Input;

namespace Mist.Terminal;

public partial class ConfirmWindow : Window
{
    public ConfirmWindow(string title, string message, string accept = "确定", string? detail = null, bool confirmation = true)
    {
        InitializeComponent();
        Heading.Text = title; Message.Text = message; AcceptButton.Content = accept;
        if (!string.IsNullOrEmpty(detail)) { Detail.Text = detail; DetailPanel.Visibility = Visibility.Visible; }
        CancelButton.Visibility = confirmation ? Visibility.Visible : Visibility.Collapsed;
        Loaded += (_, _) => { if (confirmation) CancelButton.Focus(); else AcceptButton.Focus(); };
        PreviewKeyDown += (_, e) => { if (e.Key == Key.Escape) { e.Handled = true; DialogResult = false; } };
    }
    public static bool Ask(Window owner, string title, string message, string accept = "确定", string? detail = null, bool confirmation = true)
    {
        var dialog = new ConfirmWindow(title, message, accept, detail, confirmation) { Owner = owner };
        return dialog.ShowDialog() == true;
    }
    private void AcceptClick(object sender, RoutedEventArgs e) => DialogResult = true;
    private void DismissClick(object sender, RoutedEventArgs e) => DialogResult = false;
    private void HeaderDrag(object sender, MouseButtonEventArgs e)
    {
        if (e.OriginalSource is System.Windows.Controls.TextBlock or System.Windows.Controls.Image) DragMove();
    }
}
