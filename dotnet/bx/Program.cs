// bx.exe: the native front door for the bx CLI.
//
// A single bx command costs a Bun start-up (~70 ms) before it does anything.
// This exe starts in a few ms, reads ~/.bx/run/<profile>.json, posts the whole
// command line to the daemon's POST /argv, and writes back the stdout, stderr
// and exit code the Bun CLI would have produced (src/argv/serve.ts renders
// them with the CLI's own code). Anything it can't serve runs
// `bun <repo>\src\cli.ts <args>` instead, with inherited stdio:
//   - no run file, or the connection is refused (no daemon: the CLI spawns one)
//   - a verb only the CLI runs (LocalVerbs, mirrored from src/argv/parse.ts)
//   - the daemon answers {"fallback":true}, or 400/401/404 (nothing ran)
// A request that reached the daemon is never re-sent, so an action can't run twice.

using System;
using System.Buffers;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Text;
using System.Text.Json;

namespace Bx;

internal static partial class Program
{
    // Keep in step with LOCAL_VERBS in src/argv/parse.ts.
    private static readonly HashSet<string> LocalVerbs = new(StringComparer.Ordinal)
    {
        "run", "agent", "bench", "-", "do", "install-skill", "profiles", "stop", "doctor", "gc", "help", "-h", "--help",
    };

    // Environment the daemon needs to render exactly as the CLI would.
    private static readonly string[] ForwardedEnv = ["BX_TIMING", "MSYSTEM", "EXEPATH", "CLAUDE_CODE_SESSION_ID"];

    private const int FallbackCode = -1;

    // Daemon deadlines are the real limit (drive and recordings set their own);
    // this only guarantees bx.exe can never hang forever on a wedged daemon.
    private const int SocketCeilingMs = 15 * 60 * 1000;

    private static int Main(string[] args)
    {
        var code = TryDaemon(args);
        return code == FallbackCode ? RunBun(args) : code;
    }

    /// <summary>Profile and verb, located the way extractGlobals does; null means "let the CLI decide".</summary>
    private static (string Profile, string Verb)? Locate(string[] args)
    {
        var profile = "default";
        string? verb = null;
        for (var i = 0; i < args.Length; i++)
        {
            var arg = args[i];
            if (arg == "--help" || arg == "-h") return null;
            if (arg == "--profile")
            {
                if (i + 1 >= args.Length) return null;
                profile = args[++i];
                continue;
            }
            if (arg == "--deadline")
            {
                i++;
                continue;
            }
            if (arg == "--headless" || arg == "--json") continue;
            verb ??= arg;
        }
        if (verb is null || LocalVerbs.Contains(verb)) return null;
        return (profile, verb);
    }

    private static int TryDaemon(string[] args)
    {
        var located = Locate(args);
        if (located is null) return FallbackCode;
        var profile = located.Value.Profile;

        var run = ReadRunFile(profile);
        if (run is null) return FallbackCode;
        var (port, token) = run.Value;

        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp)
        {
            NoDelay = true,
            SendTimeout = SocketCeilingMs,
            ReceiveTimeout = SocketCeilingMs,
        };
        try
        {
            socket.Connect(new IPEndPoint(IPAddress.Loopback, port));
        }
        catch (SocketException)
        {
            // Nothing was sent: the CLI discovers or spawns a daemon and runs the command.
            return FallbackCode;
        }

        byte[] response;
        try
        {
            socket.Send(BuildRequest(port, token, args));
            response = ReadToEnd(socket);
        }
        catch (SocketException e)
        {
            return Fail($"daemon unreachable for profile \"{profile}\": {e.Message}");
        }

        return HandleResponse(response, profile);
    }

    private static (int Port, string Token)? ReadRunFile(string profile)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        byte[] raw;
        try
        {
            raw = File.ReadAllBytes(Path.Combine(home, ".bx", "run", profile + ".json"));
        }
        catch (IOException)
        {
            return null;
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }

        int? port = null;
        string? token = null;
        try
        {
            var reader = new Utf8JsonReader(raw);
            while (reader.Read())
            {
                if (reader.TokenType != JsonTokenType.PropertyName || reader.CurrentDepth != 1) continue;
                if (reader.ValueTextEquals("port"))
                {
                    reader.Read();
                    if (reader.TokenType == JsonTokenType.Number && reader.TryGetInt32(out var p)) port = p;
                }
                else if (reader.ValueTextEquals("token"))
                {
                    reader.Read();
                    if (reader.TokenType == JsonTokenType.String) token = reader.GetString();
                }
            }
        }
        catch (JsonException)
        {
            return null;
        }
        if (port is null || token is null) return null;
        return (port.Value, token);
    }

    private static byte[] BuildRequest(int port, string token, string[] args)
    {
        var body = new ArrayBufferWriter<byte>();
        using (var w = new Utf8JsonWriter(body))
        {
            w.WriteStartObject();
            w.WriteStartArray("argv");
            foreach (var arg in args) w.WriteStringValue(arg);
            w.WriteEndArray();
            w.WriteString("cwd", Environment.CurrentDirectory);
            w.WriteNumber("pid", Environment.ProcessId);
            w.WriteStartObject("env");
            foreach (var key in ForwardedEnv)
            {
                var value = Environment.GetEnvironmentVariable(key);
                if (value is not null) w.WriteString(key, value);
            }
            w.WriteEndObject();
            w.WriteEndObject();
        }

        var head = Encoding.ASCII.GetBytes(
            $"POST /argv HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nx-bx-token: {token}\r\n" +
            $"Content-Length: {body.WrittenCount}\r\nConnection: close\r\n\r\n");
        var request = new byte[head.Length + body.WrittenCount];
        head.CopyTo(request, 0);
        body.WrittenSpan.CopyTo(request.AsSpan(head.Length));
        return request;
    }

    private static byte[] ReadToEnd(Socket socket)
    {
        using var ms = new MemoryStream();
        var buf = new byte[16384];
        int n;
        while ((n = socket.Receive(buf)) > 0) ms.Write(buf, 0, n);
        return ms.ToArray();
    }

    private static int HandleResponse(byte[] response, string profile)
    {
        var split = response.AsSpan().IndexOf("\r\n\r\n"u8);
        if (split < 0) return Fail($"daemon unreachable for profile \"{profile}\": truncated response");
        var status = ParseStatus(response.AsSpan(0, split));
        // An old daemon without /argv (404), a stale token (401) or a body it
        // refused (400): the command never ran, so the CLI can run it.
        if (status == 404 || status == 401 || status == 400) return FallbackCode;
        if (status != 200) return Fail($"daemon unreachable for profile \"{profile}\": HTTP {status}");

        string? stdout = null;
        string? stderr = null;
        int? exit = null;
        var fallback = false;
        try
        {
            var reader = new Utf8JsonReader(response.AsSpan(split + 4));
            while (reader.Read())
            {
                if (reader.TokenType != JsonTokenType.PropertyName || reader.CurrentDepth != 1) continue;
                if (reader.ValueTextEquals("stdout"))
                {
                    reader.Read();
                    stdout = reader.GetString();
                }
                else if (reader.ValueTextEquals("stderr"))
                {
                    reader.Read();
                    stderr = reader.GetString();
                }
                else if (reader.ValueTextEquals("exit"))
                {
                    reader.Read();
                    exit = reader.GetInt32();
                }
                else if (reader.ValueTextEquals("fallback"))
                {
                    reader.Read();
                    fallback = reader.TokenType == JsonTokenType.True;
                }
            }
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
        {
            return Fail($"unexpected daemon response: {e.Message}");
        }

        if (fallback) return FallbackCode;
        if (stdout is null || stderr is null || exit is null) return Fail("unexpected daemon response (HTTP 200)");
        Write(Console.OpenStandardOutput(), stdout);
        Write(Console.OpenStandardError(), stderr);
        return exit.Value;
    }

    private static int ParseStatus(ReadOnlySpan<byte> head)
    {
        // "HTTP/1.1 200 OK"
        var space = head.IndexOf((byte)' ');
        if (space < 0 || head.Length < space + 4) return 0;
        var digits = head.Slice(space + 1, 3);
        var status = 0;
        foreach (var b in digits)
        {
            if (b < (byte)'0' || b > (byte)'9') return 0;
            status = status * 10 + (b - '0');
        }
        return status;
    }

    private static void Write(Stream stream, string text)
    {
        if (text.Length == 0) return;
        var bytes = Encoding.UTF8.GetBytes(text);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    private static int Fail(string message)
    {
        Write(Console.OpenStandardError(), $"✗ {message}\n");
        return 3;
    }

    [LibraryImport("kernel32.dll")]
    private static partial IntPtr GetConsoleWindow();

    /// <summary>
    /// The Bun CLI, same arguments; its exit code is ours. Run from a terminal
    /// (bx.exe has a console window) the child shares that console: colors,
    /// Ctrl+C and stdin behave as if bun had been run directly. Spawned hidden
    /// (no console window, e.g. a script's windowsHide), the child gets
    /// CREATE_NO_WINDOW and piped stdio that bx.exe relays, so it can never
    /// open a console window of its own.
    /// </summary>
    private static int RunBun(string[] args)
    {
        var home = Environment.GetEnvironmentVariable("BX_HOME");
        var root = string.IsNullOrEmpty(home)
            ? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, ".."))
            : home;
        var hidden = GetConsoleWindow() == IntPtr.Zero;
        var start = new ProcessStartInfo("bun")
        {
            UseShellExecute = false,
            CreateNoWindow = hidden,
            RedirectStandardInput = hidden,
            RedirectStandardOutput = hidden,
            RedirectStandardError = hidden,
        };
        start.ArgumentList.Add(Path.Combine(root, "src", "cli.ts"));
        foreach (var arg in args) start.ArgumentList.Add(arg);

        // With a shared console, Ctrl+C reaches the child too; stay alive to
        // collect its exit code.
        if (!hidden) Console.CancelKeyPress += (_, e) => e.Cancel = true;
        try
        {
            using var child = Process.Start(start);
            if (child is null) return Fail("bx.exe: bun did not start");
            if (!hidden)
            {
                child.WaitForExit();
                return child.ExitCode;
            }

            var stdout = Relay(child.StandardOutput.BaseStream, Console.OpenStandardOutput(), closeTarget: false);
            var stderr = Relay(child.StandardError.BaseStream, Console.OpenStandardError(), closeTarget: false);
            // stdin may stay open forever (a parent that never closes its end):
            // relay it in the background and never wait for it.
            Relay(Console.OpenStandardInput(), child.StandardInput.BaseStream, closeTarget: true);
            child.WaitForExit();
            stdout.Join();
            stderr.Join();
            return child.ExitCode;
        }
        catch (Win32Exception e)
        {
            return Fail($"bx.exe: can't start bun ({e.Message}); is it on PATH?");
        }
    }

    private static Thread Relay(Stream from, Stream to, bool closeTarget)
    {
        var thread = new Thread(() =>
        {
            try
            {
                var buf = new byte[16384];
                int n;
                while ((n = from.Read(buf, 0, buf.Length)) > 0)
                {
                    to.Write(buf, 0, n);
                    to.Flush();
                }
            }
            catch (IOException)
            {
                // The other end went away (child exited, reader closed): stop relaying.
            }
            catch (ObjectDisposedException)
            {
                // Same, after the child's streams were disposed.
            }
            finally
            {
                if (closeTarget) to.Dispose();
            }
        })
        {
            IsBackground = true,
        };
        thread.Start();
        return thread;
    }
}
