#!/usr/bin/env python3
"""
TaskBolt Engine Auto-Setup
Checks for Python installation and installs required dependencies.
Returns JSON progress updates via stdout for the Tauri frontend to display.
"""

import sys
import os
import json
import subprocess
import sysconfig
from pathlib import Path

def emit_progress(status: str, message: str, percent: int = 0):
    """Send progress update to Tauri frontend via stdout."""
    print(json.dumps({
        "type": "setup_progress",
        "status": status,  # "checking", "installing", "success", "error"
        "message": message,
        "percent": percent
    }, ensure_ascii=False), flush=True)

def check_python_version():
    """Check if Python version meets requirements (3.9+)."""
    emit_progress("checking", "Checking Python version...", 10)
    
    version = sys.version_info
    if version.major < 3 or (version.major == 3 and version.minor < 9):
        return False, f"Python {version.major}.{version.minor} detected, but 3.9+ required"
    
    return True, f"Python {version.major}.{version.minor}.{version.micro} ✓"

def check_pip_available():
    """Check if pip is available."""
    emit_progress("checking", "Checking pip...", 20)
    
    try:
        result = subprocess.run(
            [sys.executable, "-m", "pip", "--version"],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            return True, "pip available ✓"
        return False, "pip not found"
    except Exception as e:
        return False, f"pip check failed: {str(e)}"

def check_dependencies():
    """Check if required dependencies are already installed."""
    emit_progress("checking", "Checking dependencies...", 30)
    
    required = ["httpx"]
    missing = []
    
    for package in required:
        try:
            __import__(package)
        except ImportError:
            missing.append(package)
    
    if missing:
        return False, f"Missing: {', '.join(missing)}"
    
    return True, "All dependencies installed ✓"

def install_dependencies():
    """Install required dependencies using pip."""
    emit_progress("installing", "Installing dependencies...", 40)
    
    requirements_file = Path(__file__).parent / "requirements.txt"
    
    if not requirements_file.exists():
        # Fallback: install packages directly
        packages = ["httpx>=0.27.0", "aiohttp>=3.9.0", "psutil>=5.9.0"]
        cmd = [sys.executable, "-m", "pip", "install", "--quiet"] + packages
    else:
        cmd = [sys.executable, "-m", "pip", "install", "--quiet", "-r", str(requirements_file)]
    
    try:
        # Run pip install
        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            universal_newlines=True
        )
        
        # Read output line by line
        for line in process.stderr:
            line = line.strip()
            if line and not line.startswith("WARNING"):
                # Parse pip progress (e.g., "Downloading httpx-0.27.0...")
                if "Downloading" in line or "Installing" in line:
                    emit_progress("installing", line, 60)
                elif "Successfully installed" in line:
                    emit_progress("installing", "Dependencies installed ✓", 90)
        
        process.wait()
        
        if process.returncode != 0:
            return False, "pip install failed"
        
        return True, "Dependencies installed ✓"
        
    except Exception as e:
        return False, f"Installation failed: {str(e)}"

def verify_installation():
    """Verify that all dependencies are now importable."""
    emit_progress("checking", "Verifying installation...", 95)
    
    required = ["httpx"]
    failed = []
    
    for package in required:
        try:
            __import__(package)
        except ImportError:
            failed.append(package)
    
    if failed:
        return False, f"Verification failed: {', '.join(failed)}"
    
    return True, "Verification complete ✓"

def main():
    """Main setup flow."""
    try:
        # Step 1: Check Python version
        ok, msg = check_python_version()
        if not ok:
            emit_progress("error", msg, 0)
            return 1
        
        # Step 2: Check pip
        ok, msg = check_pip_available()
        if not ok:
            emit_progress("error", msg, 0)
            return 1
        
        # Step 3: Check if dependencies already installed
        ok, msg = check_dependencies()
        if ok:
            emit_progress("success", "Setup complete! All dependencies ready.", 100)
            return 0
        
        # Step 4: Install dependencies
        ok, msg = install_dependencies()
        if not ok:
            emit_progress("error", msg, 0)
            return 1
        
        # Step 5: Verify installation
        ok, msg = verify_installation()
        if not ok:
            emit_progress("error", msg, 0)
            return 1
        
        emit_progress("success", "Setup complete! Engine ready.", 100)
        return 0
        
    except Exception as e:
        emit_progress("error", f"Setup failed: {str(e)}", 0)
        return 1

if __name__ == "__main__":
    sys.exit(main())
