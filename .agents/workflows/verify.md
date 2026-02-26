---
description: How to verify changes to the PMS server work correctly
---
// turbo-all

## Steps

1. If any C++ files were changed, recompile:
```bash
cd /Users/mac/cgki/minimalte/engine_simplx && make release 2>&1 | tail -5
```

2. Check if server is running:
```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null
```

3. If server is not running, start it:
```bash
cd /Users/mac/cgki/minimalte && npm run dev
```

4. Wait 5 seconds for server startup, then run the verification script:
```bash
cd /Users/mac/cgki/minimalte && node ./DEBUG_MAKEITWORK
```

5. Check the server logs for any errors:
```bash
# Look for recent errors in the server output
```

6. If verification passes, report success. If it fails, diagnose from the logs — do NOT guess at fixes.
