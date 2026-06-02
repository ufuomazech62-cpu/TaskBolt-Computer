#!/usr/bin/env python3
"""
Terminal Execution Skill — Run shell commands safely with timeout and output capture
"""

import subprocess
import os
import json
import platform
from typing import Dict, Any, Optional
from pathlib import Path


def run_command(
    command: str,
    timeout: int = 30,
    cwd: Optional[str] = None,
    shell: bool = True,
    env: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """
    Execute a shell command with safety controls.
    
    Args:
        command: The command to run
        timeout: Max seconds (default 30, max 300)
        cwd: Working directory
        shell: Use shell (default True)
        env: Additional environment variables
    
    Returns:
        Dict with stdout, stderr, exit_code, timed_out
    """
    timeout = min(timeout, 300)  # Cap at 5 minutes
    
    # Safety: block dangerous commands
    dangerous = ["rm -rf /", "mkfs", "dd if=", ":(){:|:&};:", "format c:"]
    cmd_lower = command.lower()
    for d in dangerous:
        if d in cmd_lower:
            return {
                "error": f"Blocked dangerous command: {d}",
                "stdout": "",
                "stderr": "Safety check blocked this command",
                "exit_code": -1,
            }
    
    # Build environment
    run_env = os.environ.copy()
    if env:
        run_env.update(env)
    
    # Resolve working directory
    if cwd:
        cwd_path = Path(cwd).expanduser().resolve()
        if not cwd_path.exists():
            cwd_path = None
    else:
        cwd_path = Path.home()
    
    result = {
        "command": command,
        "cwd": str(cwd_path) if cwd_path else None,
        "stdout": "",
        "stderr": "",
        "exit_code": -1,
        "timed_out": False,
    }
    
    try:
        proc = subprocess.run(
            command,
            shell=shell,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd_path,
            env=run_env,
        )
        result["stdout"] = proc.stdout[:50000]  # Cap output
        result["stderr"] = proc.stderr[:10000]
        result["exit_code"] = proc.returncode
    except subprocess.TimeoutExpired:
        result["timed_out"] = True
        result["stderr"] = f"Command timed out after {timeout}s"
    except Exception as e:
        result["stderr"] = f"Execution error: {e}"
    
    return result


def system_info() -> Dict[str, Any]:
    """Gather system information."""
    info = {
        "platform": platform.system(),
        "release": platform.release(),
        "version": platform.version(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "hostname": platform.node(),
        "python_version": platform.python_version(),
    }
    
    # Windows-specific
    if platform.system() == "Windows":
        r = run_command("wmic cpu get Name,NumberOfCores,NumberOfLogicalProcessors /format:list", timeout=10)
        if r["exit_code"] == 0:
            info["cpu_details"] = r["stdout"].strip()
        
        r = run_command("wmic memorychip get Capacity,Speed /format:list", timeout=10)
        if r["exit_code"] == 0:
            info["memory_details"] = r["stdout"].strip()
        
        r = run_command("wmic diskdrive get Model,Size /format:list", timeout=10)
        if r["exit_code"] == 0:
            info["disk_details"] = r["stdout"].strip()
    
    # Linux/macOS
    else:
        r = run_command("uname -a", timeout=5)
        if r["exit_code"] == 0:
            info["uname"] = r["stdout"].strip()
        
        r = run_command("cat /proc/cpuinfo | head -20" if platform.system() == "Linux" else "sysctl -n machdep.cpu.brand_string", timeout=5)
        if r["exit_code"] == 0:
            info["cpu_details"] = r["stdout"].strip()
    
    return info


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        cmd = " ".join(sys.argv[1:])
        result = run_command(cmd)
        print(json.dumps(result, indent=2))
    else:
        print(json.dumps(system_info(), indent=2))
