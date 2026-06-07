import os, sys
sys.path.insert(0, '.')

# Parse .env properly
with open(os.path.expanduser('~/.taskbolt/.env')) as f:
    for line in f:
        line = line.strip()
        if line.startswith('COMPOSIO_API_KEY='):
            os.environ['COMPOSIO_API_KEY'] = line.split('=',1)[1].strip()
            break

from core.composio_client import ComposioClient
import json

c = ComposioClient()

# Try different endpoints to find where tools are listed
endpoints = [
    '/actions?toolkit_slug=gmail',
    '/toolkits/gmail/actions', 
    '/tools?toolkit_slug=gmail',
    '/toolkits/gmail/tools',
]

for ep in endpoints:
    result = c._api('GET', ep)
    print(f'\n=== {ep} ===')
    print(f'Status: {result["status"]}, OK: {result["ok"]}')
    if result['ok']:
        data = result['data']
        if isinstance(data, list):
            print(f'List with {len(data)} items')
            if data:
                print(f'First item keys: {list(data[0].keys())[:10]}')
                print(f'First item sample: {json.dumps(data[0], indent=2)[:300]}')
        elif isinstance(data, dict):
            print(f'Dict keys: {list(data.keys())[:15]}')
            if 'items' in data:
                print(f'Items count: {len(data["items"])}')
                if data['items']:
                    print(f'First item: {json.dumps(data["items"][0], indent=2)[:300]}')
    else:
        print(f'Error: {result.get("error", "")[:200]}')
