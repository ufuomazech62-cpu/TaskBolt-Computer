import os, sys, json
sys.path.insert(0, '.')

with open(os.path.expanduser('~/.taskbolt/.env')) as f:
    for line in f:
        line = line.strip()
        if line.startswith('COMPOSIO_API_KEY='):
            os.environ['COMPOSIO_API_KEY'] = line.split('=',1)[1].strip()
            break

from core.composio_client import ComposioClient

c = ComposioClient()
result = c._api('GET', '/tools?toolkit_slug=gmail')

if result['ok']:
    data = result['data']
    print(f"Total items: {data.get('total_items')}")
    print(f"Current page: {data.get('current_page')}/{data.get('total_pages')}")
    print(f"\nFirst tool full structure:")
    print(json.dumps(data['items'][0], indent=2))
    
    print(f"\n\nAll tool slugs:")
    for item in data['items']:
        print(f"  - {item['slug']}: {item['name']}")
