using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

internal static class CodexConfigHostLauncher
{
    private static int Main()
    {
        var launcherDir = AppContext.BaseDirectory;
        var hostScript = Path.GetFullPath(Path.Combine(launcherDir, "..", "codex_config_host.cjs"));
        var nodePathFile = Path.Combine(launcherDir, "codex_config_host_node_path.txt");

        if (!File.Exists(hostScript))
        {
            Console.Error.WriteLine("[CodexSwitch] Host script not found: " + hostScript);
            return 1;
        }

        foreach (var candidate in CandidateNodePaths(nodePathFile))
        {
            if (!string.IsNullOrWhiteSpace(candidate) && File.Exists(candidate))
            {
                return StartNode(candidate, hostScript);
            }
        }

        Console.Error.WriteLine("[CodexSwitch] Node.js executable not found; please reinstall native_host/install.ps1");
        return 127;
    }

    private static IEnumerable<string> CandidateNodePaths(string nodePathFile)
    {
        if (File.Exists(nodePathFile))
        {
            var installedNodePath = File.ReadAllText(nodePathFile).Trim();
            if (!string.IsNullOrWhiteSpace(installedNodePath))
            {
                yield return installedNodePath;
            }
        }

        var envNodePath = Environment.GetEnvironmentVariable("CODEX_NODE_PATH");
        if (!string.IsNullOrWhiteSpace(envNodePath))
        {
            yield return envNodePath;
        }

        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "nodejs", "node.exe");
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "nodejs", "node.exe");
        yield return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "nodejs", "node.exe");

        foreach (var discovered in DiscoverFromWhere())
        {
            yield return discovered;
        }
    }

    private static int StartNode(string nodePath, string hostScript)
    {
        var process = new Process();
        process.StartInfo = new ProcessStartInfo
        {
            FileName = nodePath,
            Arguments = "\"" + hostScript + "\"",
            UseShellExecute = false,
            RedirectStandardInput = false,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
            WorkingDirectory = Path.GetDirectoryName(hostScript) ?? AppContext.BaseDirectory,
        };

        process.Start();
        process.WaitForExit();
        return process.ExitCode;
    }

    private static IEnumerable<string> DiscoverFromWhere()
    {
        Process process;

        try
        {
            process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = "where.exe",
                Arguments = "node.exe",
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            process.Start();
        }
        catch
        {
            yield break;
        }

        using (process)
        {
            while (!process.StandardOutput.EndOfStream)
            {
                var line = process.StandardOutput.ReadLine();
                if (!string.IsNullOrWhiteSpace(line))
                {
                    yield return line.Trim();
                }
            }

            process.WaitForExit();
        }
    }
}
