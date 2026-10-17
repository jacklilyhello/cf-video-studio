#!/usr/bin/env python3
"""Run gh using the already-authorized Git credential in a private child env.

No credential is printed, placed in argv, or persisted into gh configuration.
"""
import os
import subprocess
import sys
result=subprocess.run(['git','credential','fill'],input='protocol=https\nhost=github.com\n\n',text=True,capture_output=True,env={**os.environ,'GIT_TERMINAL_PROMPT':'0'})
values=dict(x.split('=',1) for x in result.stdout.splitlines() if '=' in x)
if not values.get('password'):
    sys.exit('No authorized Git credential is available')
process=subprocess.run(['gh',*sys.argv[1:]],env={**os.environ,'GH_TOKEN':values['password']})
sys.exit(process.returncode)
