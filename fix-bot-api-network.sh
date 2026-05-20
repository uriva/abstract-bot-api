cd /home/uri/uriva/abstract-bot-api
git fetch origin main
git checkout main
sed -i 's/  "whatsapp-for-business",/  "whatsapp-for-business",\n  "github",/' client/src/apiTyping.ts
deno check src/index.ts
git diff
