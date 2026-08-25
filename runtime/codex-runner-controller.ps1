[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$RequestPath
)

$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestPath -Raw -Encoding UTF8 | ConvertFrom-Json

Add-Type -ReferencedAssemblies 'System.Web.Extensions.dll' -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace SkillGraft.LocalRunner
{
    public static class CodexController
    {
        private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
        private const int JobObjectExtendedLimitInformation = 9;
        private static readonly UTF8Encoding Utf8 = new UTF8Encoding(false);

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
        {
            public long PerProcessUserTimeLimit;
            public long PerJobUserTimeLimit;
            public uint LimitFlags;
            public UIntPtr MinimumWorkingSetSize;
            public UIntPtr MaximumWorkingSetSize;
            public uint ActiveProcessLimit;
            public UIntPtr Affinity;
            public uint PriorityClass;
            public uint SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct IO_COUNTERS
        {
            public ulong ReadOperationCount;
            public ulong WriteOperationCount;
            public ulong OtherOperationCount;
            public ulong ReadTransferCount;
            public ulong WriteTransferCount;
            public ulong OtherTransferCount;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
            public IO_COUNTERS IoInfo;
            public UIntPtr ProcessMemoryLimit;
            public UIntPtr JobMemoryLimit;
            public UIntPtr PeakProcessMemoryUsed;
            public UIntPtr PeakJobMemoryUsed;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            IntPtr job,
            int informationClass,
            IntPtr information,
            uint informationLength);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        private sealed class BoundedUtf8Log : IDisposable
        {
            private static readonly byte[] Truncation = Utf8.GetBytes("\n[skill-graft: bounded log truncated]\n");
            private readonly object gate = new object();
            private readonly FileStream stream;
            private readonly long maximumBytes;
            private bool truncated;

            public BoundedUtf8Log(string path, long maximumBytes)
            {
                this.maximumBytes = Math.Max(Truncation.Length, maximumBytes);
                Directory.CreateDirectory(Path.GetDirectoryName(path));
                stream = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
            }

            public void AppendLine(string line)
            {
                lock (gate)
                {
                    if (truncated) return;
                    byte[] bytes = Utf8.GetBytes((line ?? String.Empty) + Environment.NewLine);
                    long remaining = maximumBytes - Truncation.Length - stream.Length;
                    if (bytes.Length <= remaining)
                    {
                        stream.Write(bytes, 0, bytes.Length);
                        stream.Flush();
                        return;
                    }

                    if (remaining > 0)
                    {
                        string text = line ?? String.Empty;
                        int characters = 0;
                        int used = 0;
                        while (characters < text.Length)
                        {
                            int width = Char.IsHighSurrogate(text[characters])
                                && characters + 1 < text.Length
                                && Char.IsLowSurrogate(text[characters + 1]) ? 2 : 1;
                            int next = Utf8.GetByteCount(text.Substring(characters, width));
                            if (used + next > remaining) break;
                            used += next;
                            characters += width;
                        }
                        if (characters > 0)
                        {
                            byte[] prefix = Utf8.GetBytes(text.Substring(0, characters));
                            stream.Write(prefix, 0, prefix.Length);
                        }
                    }
                    stream.Write(Truncation, 0, Truncation.Length);
                    stream.Flush();
                    truncated = true;
                }
            }

            public void Dispose()
            {
                lock (gate) stream.Dispose();
            }
        }

        private sealed class StructuredEvents : IDisposable
        {
            private readonly object gate = new object();
            private readonly BoundedUtf8Log log;
            private readonly JavaScriptSerializer json = new JavaScriptSerializer();
            private long sequence;

            public string ThreadId { get; private set; }
            public bool SawTurnCompleted { get; private set; }
            public bool SawTurnFailed { get; private set; }
            public long Count { get { lock (gate) return sequence; } }

            public StructuredEvents(string path, long maximumBytes)
            {
                log = new BoundedUtf8Log(path, maximumBytes);
            }

            public void Lifecycle(string type)
            {
                lock (gate) Append(type, null, null, null);
            }

            public void Codex(string line)
            {
                if (String.IsNullOrWhiteSpace(line)) return;
                lock (gate)
                {
                    try
                    {
                        Dictionary<string, object> value = json.DeserializeObject(line) as Dictionary<string, object>;
                        if (value == null || !value.ContainsKey("type")) return;
                        string type = Convert.ToString(value["type"]);
                        string threadId = Text(value, "thread_id");
                        Dictionary<string, object> item = Object(value, "item");
                        string itemType = item == null ? null : Text(item, "type");
                        string itemId = item == null ? null : Text(item, "id");
                        if (type == "thread.started" && !String.IsNullOrWhiteSpace(threadId)) ThreadId = threadId;
                        if (type == "turn.completed") SawTurnCompleted = true;
                        if (type == "turn.failed" || type == "error") SawTurnFailed = true;
                        Append(type, threadId, itemType, itemId);
                    }
                    catch (Exception)
                    {
                        Append("runner.invalid-json-event", null, null, null);
                    }
                }
            }

            private static Dictionary<string, object> Object(Dictionary<string, object> value, string name)
            {
                object found;
                return value.TryGetValue(name, out found) ? found as Dictionary<string, object> : null;
            }

            private static string Text(Dictionary<string, object> value, string name)
            {
                object found;
                return value != null && value.TryGetValue(name, out found) && found != null
                    ? Convert.ToString(found)
                    : null;
            }

            private void Append(string type, string threadId, string itemType, string itemId)
            {
                sequence += 1;
                StringBuilder text = new StringBuilder();
                text.Append("{\"eventVersion\":1,\"sequence\":").Append(sequence);
                text.Append(",\"at\":\"").Append(Escape(DateTime.UtcNow.ToString("o", CultureInfo.InvariantCulture))).Append("\"");
                text.Append(",\"type\":\"").Append(Escape(type)).Append("\"");
                Add(text, "threadId", threadId);
                Add(text, "itemType", itemType);
                Add(text, "itemId", itemId);
                text.Append("}");
                log.AppendLine(text.ToString());
            }

            public void Dispose() { log.Dispose(); }
        }

        public static int Run(
            string sessionId,
            string attemptId,
            string executable,
            string[] arguments,
            string[] environmentNames,
            string[] environmentValues,
            string workingDirectory,
            string promptPath,
            string stdoutPath,
            string stderrPath,
            string eventsPath,
            string lastMessagePath,
            string cancelPath,
            string statusPath,
            string receiptPath,
            long maximumStdoutBytes,
            long maximumStderrBytes,
            long maximumEventsBytes)
        {
            int controllerPid = Process.GetCurrentProcess().Id;
            int childPid = 0;
            int exitCode = -1;
            bool cancellationRequested = false;
            string startedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
            string errorText = null;
            IntPtr job = IntPtr.Zero;
            Process child = null;

            Directory.CreateDirectory(Path.GetDirectoryName(statusPath));
            WriteStatus(statusPath, sessionId, attemptId, "starting", controllerPid, childPid, null, startedAt, null);

            using (BoundedUtf8Log stdout = new BoundedUtf8Log(stdoutPath, maximumStdoutBytes))
            using (BoundedUtf8Log stderr = new BoundedUtf8Log(stderrPath, maximumStderrBytes))
            using (StructuredEvents events = new StructuredEvents(eventsPath, maximumEventsBytes))
            {
                events.Lifecycle("runner.controller.started");
                try
                {
                    job = CreateKillOnCloseJob();
                    ProcessStartInfo start = new ProcessStartInfo();
                    start.FileName = executable;
                    start.Arguments = JoinArguments(arguments ?? new string[0]);
                    start.WorkingDirectory = workingDirectory;
                    start.UseShellExecute = false;
                    start.CreateNoWindow = true;
                    start.RedirectStandardInput = true;
                    start.RedirectStandardOutput = true;
                    start.RedirectStandardError = true;
                    start.StandardOutputEncoding = Utf8;
                    start.StandardErrorEncoding = Utf8;
                    string[] inheritedEnvironment = new[] {
                        "SystemRoot", "WINDIR", "SystemDrive", "ComSpec", "PATH", "PATHEXT",
                        "OS", "PROCESSOR_ARCHITECTURE", "NUMBER_OF_PROCESSORS"
                    };
                    Dictionary<string, string> safeEnvironment = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                    foreach (string name in inheritedEnvironment)
                    {
                        string value = Environment.GetEnvironmentVariable(name);
                        if (!String.IsNullOrEmpty(value)) safeEnvironment[name] = value;
                    }
                    start.EnvironmentVariables.Clear();
                    foreach (KeyValuePair<string, string> pair in safeEnvironment)
                    {
                        start.EnvironmentVariables[pair.Key] = pair.Value;
                    }
                    string[] allowedEnvironment = new[] {
                        "CODEX_HOME", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
                        "XDG_CONFIG_HOME", "TEMP", "TMP", "SKILL_GRAFT_HOME", "HUB_ROOT"
                    };
                    if ((environmentNames ?? new string[0]).Length != (environmentValues ?? new string[0]).Length)
                    {
                        throw new InvalidOperationException("Controller environment names and values differ");
                    }
                    for (int index = 0; index < (environmentNames ?? new string[0]).Length; index += 1)
                    {
                        string name = environmentNames[index];
                        if (Array.IndexOf(allowedEnvironment, name) < 0)
                        {
                            throw new InvalidOperationException("Controller environment key is not allowed");
                        }
                        start.EnvironmentVariables[name] = environmentValues[index] ?? String.Empty;
                    }

                    child = new Process();
                    child.StartInfo = start;
                    child.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args)
                    {
                        if (args.Data == null) return;
                        stdout.AppendLine(args.Data);
                        events.Codex(args.Data);
                    };
                    child.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs args)
                    {
                        if (args.Data != null) stderr.AppendLine(args.Data);
                    };

                    if (!child.Start()) throw new InvalidOperationException("Codex process did not start");
                    childPid = child.Id;
                    if (!AssignProcessToJobObject(job, child.Handle))
                    {
                        int nativeError = Marshal.GetLastWin32Error();
                        try { child.Kill(); } catch { }
                        throw new InvalidOperationException("AssignProcessToJobObject failed: " + nativeError);
                    }

                    child.BeginOutputReadLine();
                    child.BeginErrorReadLine();
                    using (StreamReader prompt = new StreamReader(promptPath, Utf8, true))
                    {
                        child.StandardInput.Write(prompt.ReadToEnd());
                    }
                    child.StandardInput.Close();
                    events.Lifecycle("runner.process.started");
                    WriteStatus(statusPath, sessionId, attemptId, "running", controllerPid, childPid, null, startedAt, null);

                    while (!child.WaitForExit(75))
                    {
                        if (File.Exists(cancelPath))
                        {
                            cancellationRequested = true;
                            events.Lifecycle("runner.cancel.requested");
                            WriteStatus(statusPath, sessionId, attemptId, "cancelling", controllerPid, childPid, null, startedAt, null);
                            if (!TerminateJobObject(job, 1223))
                            {
                                throw new InvalidOperationException("TerminateJobObject failed: " + Marshal.GetLastWin32Error());
                            }
                            break;
                        }
                    }

                    child.WaitForExit();
                    exitCode = child.ExitCode;
                    events.Lifecycle("runner.process.exited");
                }
                catch (Exception error)
                {
                    errorText = error.GetType().Name + ": " + error.Message;
                    events.Lifecycle("runner.controller.failed");
                    if (child != null && !child.HasExited)
                    {
                        try { TerminateJobObject(job, 1); } catch { }
                    }
                    try
                    {
                        if (child != null)
                        {
                            child.WaitForExit();
                            exitCode = child.ExitCode;
                        }
                    }
                    catch { }
                }
                finally
                {
                    if (job != IntPtr.Zero) CloseHandle(job);
                    if (child != null) child.Dispose();
                }

                string endedAt = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
                string state = cancellationRequested ? "cancelled" : errorText != null ? "failed" : "exited";
                WriteReceipt(
                    receiptPath,
                    sessionId,
                    attemptId,
                    state,
                    controllerPid,
                    childPid,
                    exitCode,
                    events.ThreadId,
                    events.SawTurnCompleted,
                    events.SawTurnFailed,
                    events.Count,
                    cancellationRequested,
                    startedAt,
                    endedAt,
                    errorText);
                WriteStatus(statusPath, sessionId, attemptId, state, controllerPid, childPid, exitCode, startedAt, endedAt);
                return errorText == null ? 0 : 1;
            }
        }

        private static IntPtr CreateKillOnCloseJob()
        {
            IntPtr job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new InvalidOperationException("CreateJobObject failed: " + Marshal.GetLastWin32Error());
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            int size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
            IntPtr data = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, data, false);
                if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, data, (uint)size))
                {
                    int nativeError = Marshal.GetLastWin32Error();
                    CloseHandle(job);
                    throw new InvalidOperationException("SetInformationJobObject failed: " + nativeError);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(data);
            }
            return job;
        }

        private static string JoinArguments(string[] arguments)
        {
            StringBuilder result = new StringBuilder();
            foreach (string argument in arguments)
            {
                if (result.Length > 0) result.Append(' ');
                result.Append(QuoteArgument(argument ?? String.Empty));
            }
            return result.ToString();
        }

        private static string QuoteArgument(string argument)
        {
            if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return argument;
            StringBuilder quoted = new StringBuilder("\"");
            int slashCount = 0;
            foreach (char value in argument)
            {
                if (value == '\\')
                {
                    slashCount += 1;
                    continue;
                }
                if (value == '"')
                {
                    quoted.Append('\\', slashCount * 2 + 1).Append('"');
                    slashCount = 0;
                    continue;
                }
                quoted.Append('\\', slashCount).Append(value);
                slashCount = 0;
            }
            quoted.Append('\\', slashCount * 2).Append('"');
            return quoted.ToString();
        }

        private static void WriteStatus(
            string path,
            string sessionId,
            string attemptId,
            string state,
            int controllerPid,
            int childPid,
            int? exitCode,
            string startedAt,
            string endedAt)
        {
            StringBuilder text = new StringBuilder();
            text.Append("{\"runnerStatusVersion\":1");
            Add(text, "sessionId", sessionId);
            Add(text, "attemptId", attemptId);
            Add(text, "state", state);
            text.Append(",\"controllerPid\":").Append(controllerPid);
            text.Append(",\"childPid\":").Append(childPid);
            if (exitCode.HasValue) text.Append(",\"exitCode\":").Append(exitCode.Value);
            Add(text, "startedAt", startedAt);
            Add(text, "endedAt", endedAt);
            text.Append("}");
            AtomicWrite(path, text.ToString());
        }

        private static void WriteReceipt(
            string path,
            string sessionId,
            string attemptId,
            string state,
            int controllerPid,
            int childPid,
            int exitCode,
            string threadId,
            bool sawTurnCompleted,
            bool sawTurnFailed,
            long eventCount,
            bool cancellationRequested,
            string startedAt,
            string endedAt,
            string error)
        {
            StringBuilder text = new StringBuilder();
            text.Append("{\"executionReceiptVersion\":1");
            Add(text, "sessionId", sessionId);
            Add(text, "attemptId", attemptId);
            Add(text, "state", state);
            text.Append(",\"controllerPid\":").Append(controllerPid);
            text.Append(",\"childPid\":").Append(childPid);
            text.Append(",\"exitCode\":").Append(exitCode);
            Add(text, "threadId", threadId);
            text.Append(",\"sawTurnCompleted\":").Append(sawTurnCompleted ? "true" : "false");
            text.Append(",\"sawTurnFailed\":").Append(sawTurnFailed ? "true" : "false");
            text.Append(",\"eventCount\":").Append(eventCount);
            text.Append(",\"cancellationRequested\":").Append(cancellationRequested ? "true" : "false");
            Add(text, "startedAt", startedAt);
            Add(text, "endedAt", endedAt);
            Add(text, "error", error);
            text.Append("}");
            AtomicWrite(path, text.ToString());
        }

        private static void Add(StringBuilder target, string name, string value)
        {
            if (String.IsNullOrEmpty(value)) return;
            target.Append(",\"").Append(Escape(name)).Append("\":\"").Append(Escape(value)).Append("\"");
        }

        private static string Escape(string value)
        {
            if (value == null) return String.Empty;
            StringBuilder escaped = new StringBuilder();
            foreach (char character in value)
            {
                switch (character)
                {
                    case '"': escaped.Append("\\\""); break;
                    case '\\': escaped.Append("\\\\"); break;
                    case '\b': escaped.Append("\\b"); break;
                    case '\f': escaped.Append("\\f"); break;
                    case '\n': escaped.Append("\\n"); break;
                    case '\r': escaped.Append("\\r"); break;
                    case '\t': escaped.Append("\\t"); break;
                    default:
                        if (character < 32) escaped.Append("\\u").Append(((int)character).ToString("x4"));
                        else escaped.Append(character);
                        break;
                }
            }
            return escaped.ToString();
        }

        private static void AtomicWrite(string path, string content)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temporary = path + ".tmp-" + Process.GetCurrentProcess().Id;
            File.WriteAllText(temporary, content + Environment.NewLine, Utf8);
            if (File.Exists(path)) File.Replace(temporary, path, null, true);
            else File.Move(temporary, path);
        }
    }
}
'@

$arguments = [string[]]@($request.arguments | ForEach-Object { [string]$_ })
$environmentNames = [System.Collections.Generic.List[string]]::new()
$environmentValues = [System.Collections.Generic.List[string]]::new()
if ($null -ne $request.environment) {
  foreach ($property in $request.environment.PSObject.Properties) {
    $environmentNames.Add([string]$property.Name)
    $environmentValues.Add([string]$property.Value)
  }
}
$exitCode = [SkillGraft.LocalRunner.CodexController]::Run(
  [string]$request.sessionId,
  [string]$request.attemptId,
  [string]$request.executable,
  $arguments,
  [string[]]$environmentNames.ToArray(),
  [string[]]$environmentValues.ToArray(),
  [string]$request.workingDirectory,
  [string]$request.promptPath,
  [string]$request.stdoutPath,
  [string]$request.stderrPath,
  [string]$request.eventsPath,
  [string]$request.lastMessagePath,
  [string]$request.cancelPath,
  [string]$request.statusPath,
  [string]$request.receiptPath,
  [int64]$request.maximumStdoutBytes,
  [int64]$request.maximumStderrBytes,
  [int64]$request.maximumEventsBytes
)
exit $exitCode
