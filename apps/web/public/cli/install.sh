#!/bin/sh
# Installs the standalone ak CLI (single-file bundle, no npm required).
# Usage inside an AK cloud sandbox: curl -fsS "$AK_API_URL/cli/install.sh" | sh
set -e
BASE="${AK_API_URL:?AK_API_URL is required}"
curl -fsS "$BASE/cli/ak-standalone.mjs" -o /usr/local/lib/ak-standalone.mjs
printf '#!/bin/sh\nexec node /usr/local/lib/ak-standalone.mjs "$@"\n' > /usr/local/bin/ak
chmod +x /usr/local/bin/ak
ak --version
