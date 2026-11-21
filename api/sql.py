# -*- coding: utf-8 -*-
"""문장 → SQL — Vercel 서버 함수 (Gemini, 여러 모델 중 선택).

**키를 숨기기 위해서** 서버에 있다. SQL을 실행하지는 않는다 — 실행은 브라우저의 DuckDB가 한다.
여기서는 SQL 문장을 **만들어 돌려주기만** 한다. 사람이 읽고, 고치고, 실행 버튼을 누른다.

  GET  /api/sql            → {"enabled": bool, "default": "<모델 ID>", "models": [{id, label, desc, enabled}]}
                             허용 목록만 돌려준다. 키 값은 절대 돌려주지 않는다
  GET  /api/sql?check=1    → 위 + 각 모델이 이 키로 실제 사용 가능한지 (Google 공식 models.list 조회)
  POST /api/sql            받는 것 {"question": "...", "schema": {...}, "model": "<모델 ID, 생략 가능>"}
                           주는 것 {"sql": "SELECT ...", "why": "...", "model": "<실제 사용한 모델 ID>"}
                           실패하면 {"sql": null, "code": "...", "reason": "..."}
                           키(GEMINI_API_KEY)가 없으면 Gemini 를 부르지 않고 {"sql": null, "disabled": true, "reason": "<비활성 안내>"}
                           허용 목록에 없는 모델 → 400, Gemini 를 부르지 않는다

모델 선택 규칙
  - 클라이언트가 보낸 모델 ID 는 **서버 허용 목록(ALLOWED)에 있을 때만** 쓴다. 없으면 거부(400)
  - 모델을 보내지 않으면 기본 모델: 환경 변수 GEMINI_MODEL 이 허용·활성 모델이면 그것, 아니면 DEFAULT_MODEL
  - 유료 전용 Pro 모델은 환경 변수 GEMINI_ALLOW_PRO=1 일 때만 허용 (기본 꺼짐 — 고비용 호출 방지)

모델 ID 는 Google 공식 문서(models·pricing 페이지, 2026-11 확인)에 있는 값만 둔다. 이름·무료 한도는 자주 바뀐다.
읽기(SELECT · WITH)가 아닌 SQL은 돌려주지 않는다. 외부 라이브러리를 쓰지 않는다.
"""
import json
import os
import re
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlsplit

# id → (화면 이름, 짧은 특징, 유료 전용 여부)
ALLOWED = {
    "gemini-3.8-flash": ("Gemini 3.8 Flash", "기본 · 빠른 SQL 생성, 속도와 정확도 균형", False),
    "gemini-3.6-flash": ("Gemini 3.6 Flash", "이전 세대 Flash · 안정 버전", False),
    "gemini-3.5-flash-lite": ("Gemini 3.5 Flash-Lite", "가벼운 질문 · 가장 빠르고 저렴", False),
    "gemini-3.1-pro-preview": ("Gemini 3.1 Pro (미리보기)", "복잡한 SQL · 유료 전용 · 관리자가 켠 경우만", True),
}
DEFAULT_MODEL = "gemini-3.8-flash"
ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
LIST_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000"
TIMEOUT = 25
MAX_BODY = 80000       # 요청 본문 최대 바이트
MAX_QUESTION = 300     # 질문 최대 글자
AI_OFF = "AI 질문 변환 기능은 현재 비활성화되어 있습니다. 준비한 질문 또는 직접 SQL 입력 기능을 이용해 주세요."

FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|create|alter|attach|detach|copy|pragma|install|load|export|import|call|set)\b", re.I)


def read_only(sql):
    """읽기만 하는 SQL인가. 한 문장만, SELECT/WITH 로 시작, 쓰기·설치 명령 없음."""
    s = re.sub(r"--[^\n]*", "", sql or "").strip().rstrip(";").strip()
    if not s or ";" in s:
        return None
    if not re.match(r"^(select|with)\b", s, re.I):
        return None
    if FORBIDDEN.search(re.sub(r"'[^']*'", "''", s)):
        return None
    return s


def pro_allowed():
    return os.environ.get("GEMINI_ALLOW_PRO", "").strip() == "1"


def model_enabled(mid):
    return mid in ALLOWED and (not ALLOWED[mid][2] or pro_allowed())


def default_model():
    env = os.environ.get("GEMINI_MODEL", "").strip()
    return env if model_enabled(env) else DEFAULT_MODEL


def compact_schema(schema):
    lines = []
    for t, info in schema.get("tables", {}).items():
        cols = []
        for c in info.get("columns", []):
            v = f" 값: {', '.join(map(str, c['values']))}" if c.get("values") else ""
            cols.append(f"{c['name']} {c['type']}{v}")
        lines.append(f"- {t} (한 줄 = {info.get('grain', '?')}, {info.get('rows', '?')}행): " + " | ".join(cols))
    return "\n".join(lines)


def build_prompt(question, schema):
    return f"""너는 DuckDB SQL을 쓰는 데이터 분석가다. 아래 표만 쓴다. 표에 없는 열을 지어내지 않는다.

[표]
{compact_schema(schema)}

[규칙]
- 읽기만 한다. SELECT 또는 WITH 로 시작하는 한 문장.
- **사람을 셀 때는 COUNT(DISTINCT ...)** 를 쓴다. 한 줄의 단위(한 줄 = …)를 보고 판단한다.
- 표를 이어 붙이기 전에 두 표의 «한 줄»이 같은지 본다. 다르면 먼저 묶어서(집계해서) 붙인다.
- 비율은 100을 곱해 소수 첫째 자리까지 ROUND 한다.
- 결과 열 이름은 한국어로 짧게 붙인다 (AS 사람, AS 완료율 …).
- 답할 수 없는 질문이면 sql 을 빈 문자열로 두고 why 에 이유를 쓴다.

[질문]
{question}

JSON 하나로만 답한다: {{"sql": "...", "why": "무엇을 어떻게 셌는지 한 문장"}}
"""


def call_gemini(key, model, prompt):
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0, "responseMimeType": "application/json"},
    }).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT.format(model=model), data=body, method="POST",
        headers={"Content-Type": "application/json", "x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.loads(r.read().decode("utf-8"))
    return json.loads(data["candidates"][0]["content"]["parts"][0]["text"])


def list_available(key):
    """Google 공식 models.list — 이 키로 generateContent 를 쓸 수 있는 모델 ID 집합."""
    req = urllib.request.Request(LIST_ENDPOINT, headers={"x-goog-api-key": key})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        data = json.loads(r.read().decode("utf-8"))
    return {m.get("name", "").split("/")[-1] for m in data.get("models", [])
            if "generateContent" in m.get("supportedGenerationMethods", [])}


def gemini_error(status, model):
    """Gemini HTTP 오류 → 사용자 안내. Google 응답 본문(키·프로젝트 정보가 섞일 수 있음)은 돌려주지 않는다."""
    label = ALLOWED.get(model, (model,))[0]
    if status == 429:
        return "quota", f"{label} 사용량 한도를 넘었습니다. 잠시 후 다시 시도하거나 다른 모델을 고르세요."
    if status == 404:
        return "model_unavailable", f"{label} 모델을 지금 사용할 수 없습니다 (종료됐거나 이 키로 접근 불가). 다른 모델을 고르세요."
    if status in (401, 403):
        return "forbidden", f"{label} 모델에 대한 API 키 권한이 없습니다 (유료 전용 모델이거나 키 설정 문제)."
    if status == 400:
        return "bad_request", f"{label} 모델이 요청을 거부했습니다 (HTTP 400)."
    if status >= 500:
        return "upstream", f"{label} 서버 오류입니다 (HTTP {status}). 잠시 후 다시 시도하세요."
    return "error", f"{label} 호출 실패 (HTTP {status})."


class handler(BaseHTTPRequestHandler):
    def _send(self, obj, status=200):
        raw = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        key = os.environ.get("GEMINI_API_KEY", "").strip()
        models = [{"id": mid, "label": lab, "desc": desc, "enabled": model_enabled(mid)}
                  for mid, (lab, desc, _paid) in ALLOWED.items()]
        out = {"enabled": bool(key), "default": default_model(), "models": models}
        if key and parse_qs(urlsplit(self.path).query).get("check") == ["1"]:
            try:
                avail = list_available(key)
                for m in models:
                    m["available"] = m["id"] in avail
            except urllib.error.HTTPError as e:
                out["check_error"] = f"models.list 실패 (HTTP {e.code})"
            except Exception as e:  # noqa: BLE001
                out["check_error"] = f"models.list 실패 — {type(e).__name__}"
        return self._send(out)

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            n = 0
        if n > MAX_BODY:
            return self._send({"sql": None, "code": "too_large", "reason": "요청이 너무 큽니다"}, 413)
        try:
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            if not isinstance(req, dict):
                raise ValueError
        except Exception:  # noqa: BLE001
            return self._send({"sql": None, "code": "bad_request", "reason": "요청 형식이 올바르지 않습니다"}, 400)
        model = str(req.get("model") or "").strip() or default_model()
        if not model_enabled(model):
            return self._send({"sql": None, "code": "model_not_allowed",
                               "reason": "허용되지 않은 모델입니다. 목록에 있는 모델만 쓸 수 있습니다."}, 400)
        key = os.environ.get("GEMINI_API_KEY", "").strip()
        if not key:
            return self._send({"sql": None, "disabled": True, "reason": AI_OFF})
        q = str(req.get("question", "")).strip()[:MAX_QUESTION]
        if not q:
            return self._send({"sql": None, "reason": "질문이 없습니다"})
        try:
            out = call_gemini(key, model, build_prompt(q, req.get("schema") or {}))
            sql = str(out.get("sql", "")).strip()
            why = str(out.get("why", ""))[:300]
            if not sql:
                return self._send({"sql": None, "model": model, "reason": "AI가 답할 수 없다고 했습니다 — " + why})
            safe = read_only(sql)
            if not safe:
                return self._send({"sql": None, "model": model, "reason": "AI가 읽기(SELECT)가 아닌 SQL을 썼습니다. 돌려주지 않습니다"})
            return self._send({"sql": safe, "why": why, "model": model})
        except urllib.error.HTTPError as e:
            code, msg = gemini_error(e.code, model)
            return self._send({"sql": None, "model": model, "code": code, "status": e.code, "reason": msg})
        except Exception as e:  # noqa: BLE001
            return self._send({"sql": None, "model": model, "code": "error", "reason": f"AI 호출 실패 — {type(e).__name__}"})
