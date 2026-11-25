import base64, hashlib, json, re, sys
from playwright.sync_api import sync_playwright

APP = "file:///home/claude/dashboard/index.html"
files = {}  # path -> (text, sha)

def sha(t): return hashlib.sha1(t.encode()).hexdigest()

def put_file(path, text): files[path] = (text, sha(text + path))

put_file("current.md", "# Papers\n- [ ] Write intro\n- [x] Old thing (done 2026-11-01)\n\n# Connections\n- Status: two under review\n")
put_file("history/2026/2026-11-20.md", "# Papers\n- [ ] Write intro\n- Status: as of the 20th\n")

def handler(route, request):
    url = request.url
    m = re.match(r"https://api.github.com/repos/StephenBorgatti/dashboard-data(.*)", url)
    if not m: return route.continue_()
    path = m.group(1)
    def reply(status, body): route.fulfill(status=status, content_type="application/json", body=json.dumps(body))
    if path == "":
        return reply(200, {"default_branch": "main"})
    if path.startswith("/git/trees/"):
        return reply(200, {"tree": [{"path": p} for p in files]})
    cm = re.match(r"/contents/([^?]+)", path)
    p = cm.group(1)
    if request.method == "GET":
        if p not in files: return reply(404, {})
        t, s = files[p]
        return reply(200, {"content": base64.b64encode(t.encode()).decode(), "sha": s})
    if request.method == "PUT":
        body = json.loads(request.post_data)
        cur = files.get(p)
        if (cur and body.get("sha") != cur[1]) or (not cur and body.get("sha")):
            return reply(409, {})
        put_file(p, base64.b64decode(body["content"]).decode())
        return reply(200, {"content": {"sha": files[p][1]}})

with sync_playwright() as pw:
    b = pw.chromium.launch()
    page = b.new_page(viewport={"width": 1000, "height": 700})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.route("https://api.github.com/**", handler)
    page.add_init_script("localStorage.setItem('dashboard.settings', JSON.stringify({owner:'StephenBorgatti',repo:'dashboard-data',token:'t'}))")
    page.goto(APP)
    page.wait_for_function("document.getElementById('status').textContent.startsWith('Saved')", timeout=10000)
    today = page.evaluate("(()=>{const d=new Date();return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')})()")
    # Old done item purged on load and saved, snapshot written
    assert "Old thing" not in files["current.md"][0], files["current.md"][0]
    assert f"history/{today[:4]}/{today}.md" in files
    page.screenshot(path="/home/claude/dashboard/test/shot1.png")

    # Tick the checkbox: item gets date
    page.click(".cm-task-box")
    page.wait_for_function("document.getElementById('status').textContent.startsWith('Saved')", timeout=10000)
    page.wait_for_timeout(500)
    assert f"- [x] Write intro (done {today})" in files["current.md"][0], files["current.md"][0]

    # Type a new todo
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type("- [ ] New todo")
    page.wait_for_timeout(4500)
    assert "New todo" in files["current.md"][0]
    assert files["current.md"][0] == files[f"history/{today[:4]}/{today}.md"][0]
    page.screenshot(path="/home/claude/dashboard/test/shot2.png")

    # View a past date with no exact snapshot
    page.fill("#datePick", "2026-11-22")
    page.dispatch_event("#datePick", "change")
    page.wait_for_selector("#pastBanner:not([hidden])")
    banner = page.text_content("#pastBanner")
    assert "Nov 20" in banner, banner
    assert "as of the 20th" in page.text_content(".cm-content")
    page.screenshot(path="/home/claude/dashboard/test/shot3.png")
    page.click("#todayBtn")
    page.wait_for_timeout(500)
    assert "New todo" in page.text_content(".cm-content")

    # Conflict: another device changes current.md, then we edit
    put_file("current.md", files["current.md"][0] + "- from other device\n")
    page.click(".cm-content")
    page.keyboard.press("Control+End")
    page.keyboard.type(" local edit")
    page.wait_for_selector("#conflict:not([hidden])", timeout=8000)
    page.screenshot(path="/home/claude/dashboard/test/shot4.png")
    page.click("#conflictKeep")
    page.wait_for_function("document.getElementById('status').textContent.startsWith('Saved')", timeout=10000)
    assert "local edit" in files["current.md"][0]
    assert not errors, errors
    print("browser tests passed")
    b.close()
