#!/bin/bash
# NPM Publish Checklist - HemmaBo MCP Server

echo "🔒 Security & Publishing Checklist"
echo "=================================="
echo ""

# 1. Check source code protection
echo "1️⃣ Checking source code protection..."
if npm pack --dry-run 2>&1 | grep -q "src/\|lib/\|api/"; then
    echo "❌ ERROR: Source code would be published!"
    echo "   Fix .npmignore or package.json 'files' field"
    exit 1
else
    echo "✅ Source code protected (src/, lib/, api/ excluded)"
fi

# 2. Check source maps
echo ""
echo "2️⃣ Checking source maps..."
if npm pack --dry-run 2>&1 | grep -q "\.map$"; then
    echo "❌ WARNING: Source maps would be published (may expose code)"
    echo "   Consider excluding them"
else
    echo "✅ Source maps excluded"
fi

# 3. Check required files
echo ""
echo "3️⃣ Checking required files..."
npm pack --dry-run 2>&1 | grep -q "dist/stdio.js" && echo "✅ stdio.js present (bin entry)" || echo "❌ Missing stdio.js"
npm pack --dry-run 2>&1 | grep -q "README.md" && echo "✅ README.md present" || echo "⚠️  Missing README.md"
npm pack --dry-run 2>&1 | grep -q "LICENSE" && echo "✅ LICENSE present" || echo "⚠️  Missing LICENSE"

# 4. Package size
echo ""
echo "4️⃣ Package info:"
npm pack --dry-run 2>&1 | grep "package size\|total files\|unpacked size"

echo ""
echo "=================================="
echo "If all checks pass, publish with:"
echo "  npm login"
echo "  npm publish --access public"
echo ""
