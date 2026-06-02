#!/usr/bin/env python3
"""
System Health Diagnostics — Comprehensive system analysis and troubleshooting
"""

import json
import platform
import subprocess
from typing import Dict, Any, List
from .terminal_exec import run_command


def full_diagnosis() -> Dict[str, Any]:
    """Run comprehensive system health check."""
    report = {
        "system": {},
        "performance": {},
        "network": {},
        "storage": {},
        "issues": [],
        "recommendations": [],
    }
    
    # System basics
    report["system"]["platform"] = platform.system()
    report["system"]["hostname"] = platform.node()
    
    # CPU & Memory
    if platform.system() == "Windows":
        r = run_command("wmic cpu get LoadPercentage /format:list", timeout=10)
        if r["exit_code"] == 0:
            for line in r["stdout"].split("\n"):
                if "LoadPercentage" in line:
                    load = int(line.split("=")[1].strip())
                    report["performance"]["cpu_load"] = f"{load}%"
                    if load > 80:
                        report["issues"].append(f"High CPU load: {load}%")
        
        r = run_command("wmic OS get FreePhysicalMemory,TotalVisibleMemorySize /format:list", timeout=10)
        if r["exit_code"] == 0:
            free, total = 0, 0
            for line in r["stdout"].split("\n"):
                if "FreePhysicalMemory" in line:
                    free = int(line.split("=")[1].strip())
                if "TotalVisibleMemorySize" in line:
                    total = int(line.split("=")[1].strip())
            if total > 0:
                used_pct = ((total - free) / total) * 100
                report["performance"]["memory_used"] = f"{used_pct:.1f}%"
                report["performance"]["memory_free_gb"] = f"{free / 1024 / 1024:.2f}"
                if used_pct > 85:
                    report["issues"].append(f"High memory usage: {used_pct:.1f}%")
    
    else:  # Linux/macOS
        r = run_command("top -bn1 | head -5", timeout=10)
        if r["exit_code"] == 0:
            report["performance"]["top_output"] = r["stdout"]
        
        r = run_command("free -h" if platform.system() == "Linux" else "vm_stat", timeout=10)
        if r["exit_code"] == 0:
            report["performance"]["memory"] = r["stdout"]
    
    # Disk space
    if platform.system() == "Windows":
        r = run_command("wmic logicaldisk get Size,FreeSpace,Caption /format:list", timeout=10)
        if r["exit_code"] == 0:
            disks = []
            current = {}
            for line in r["stdout"].split("\n"):
                line = line.strip()
                if "Caption=" in line:
                    if current:
                        disks.append(current)
                    current = {"drive": line.split("=")[1]}
                elif "Size=" in line and line.split("=")[1]:
                    current["size_gb"] = f"{int(line.split('=')[1]) / 1024**3:.1f}"
                elif "FreeSpace=" in line and line.split("=")[1]:
                    current["free_gb"] = f"{int(line.split('=')[1]) / 1024**3:.1f}"
            if current:
                disks.append(current)
            report["storage"]["disks"] = disks
            
            for disk in disks:
                if "size_gb" in disk and "free_gb" in disk:
                    size = float(disk["size_gb"])
                    free = float(disk["free_gb"])
                    if size > 0 and (free / size) < 0.1:
                        report["issues"].append(f"{disk['drive']} nearly full ({free:.1f}GB free)")
                        report["recommendations"].append(f"Clean up {disk['drive']} - less than 10% free")
    
    else:
        r = run_command("df -h", timeout=10)
        if r["exit_code"] == 0:
            report["storage"]["df"] = r["stdout"]
    
    # Network
    r = run_command("ping -c 3 8.8.8.8" if platform.system() != "Windows" else "ping -n 3 8.8.8.8", timeout=15)
    report["network"]["internet"] = "connected" if r["exit_code"] == 0 else "disconnected"
    if r["exit_code"] != 0:
        report["issues"].append("No internet connection")
    
    # Running processes
    if platform.system() == "Windows":
        r = run_command('wmic process get Name,WorkingSetSize /format:csv | sort /R', timeout=10)
    else:
        r = run_command("ps aux --sort=-%mem | head -15", timeout=10)
    if r["exit_code"] == 0:
        report["performance"]["top_processes"] = r["stdout"]
    
    # Recent errors (Windows Event Log)
    if platform.system() == "Windows":
        r = run_command('wevtutil qe System /c:5 /f:text /rd:true', timeout=10)
        if r["exit_code"] == 0:
            report["system"]["recent_errors"] = r["stdout"]
    
    # Startup programs
    if platform.system() == "Windows":
        r = run_command('wmic startup get Caption,Command', timeout=10)
        if r["exit_code"] == 0:
            report["system"]["startup_programs"] = r["stdout"]
            # Count startup items
            lines = [l for l in r["stdout"].split("\n") if l.strip() and "Caption" not in l]
            if len(lines) > 15:
                report["issues"].append(f"Many startup programs ({len(lines)}) - may slow boot")
                report["recommendations"].append("Review and disable unnecessary startup programs")
    
    # Generate recommendations
    if not report["issues"]:
        report["recommendations"].append("System appears healthy. No critical issues found.")
    
    return report


def diagnose_specific(area: str) -> Dict[str, Any]:
    """Diagnose a specific system area."""
    area = area.lower()
    
    if area in ["network", "wifi", "internet"]:
        result = {"area": "network", "tests": []}
        
        tests = [
            ("ping", "ping -c 3 8.8.8.8" if platform.system() != "Windows" else "ping -n 3 8.8.8.8"),
            ("dns", "ping -c 3 google.com" if platform.system() != "Windows" else "ping -n 3 google.com"),
            ("ipconfig", "ip a" if platform.system() != "Windows" else "ipconfig /all"),
            ("routes", "ip route" if platform.system() != "Windows" else "route print"),
        ]
        
        for name, cmd in tests:
            r = run_command(cmd, timeout=15)
            result["tests"].append({
                "name": name,
                "passed": r["exit_code"] == 0,
                "output": r["stdout"][:2000],
                "error": r["stderr"] if r["exit_code"] != 0 else None,
            })
        
        return result
    
    elif area in ["disk", "storage", "space"]:
        return {"area": "storage", "report": full_diagnosis()["storage"]}
    
    elif area in ["performance", "slow", "speed"]:
        return {"area": "performance", "report": full_diagnosis()["performance"]}
    
    else:
        return {"error": f"Unknown diagnostic area: {area}", "available": ["network", "disk", "performance"]}


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        result = diagnose_specific(sys.argv[1])
    else:
        result = full_diagnosis()
    print(json.dumps(result, indent=2))
