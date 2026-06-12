from __future__ import annotations

import csv
import hashlib
import hmac
import io
import json
import mimetypes
import os
import secrets
import smtplib
import sqlite3
import sys
import traceback
from datetime import datetime, timedelta, timezone
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

try:
    import openpyxl
except Exception:  # pragma: no cover - optional runtime dependency
    openpyxl = None


ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
UPLOAD_DIR = ROOT / "uploads"
DB_PATH = DATA_DIR / "psl_selection.db"
PBKDF2_ROUNDS = 180_000
SESSIONS: dict[str, dict] = {}

# --- SMTP / 邮箱验证码配置 ---
CODE_EXPIRE_MINUTES = 5
CODE_RATE_LIMIT_SECONDS = 60  # 同一邮箱两次发码最小间隔


# --- DB-backed settings with env-var fallback ---
def get_setting(conn: sqlite3.Connection, key: str) -> str:
    row = conn.execute("SELECT value FROM system_settings WHERE key = ?", (key,)).fetchone()
    if row and row["value"]:
        return row["value"]
    # Fallback to env var for backward compatibility
    env_key = f"PSL_{key.upper()}"
    return os.environ.get(env_key, "")


def set_setting(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO system_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, value),
    )


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), PBKDF2_ROUNDS
    ).hex()
    return f"pbkdf2_sha256${PBKDF2_ROUNDS}${salt}${digest}"


def verify_password(password: str, password_hash: str) -> bool:
    try:
        algo, rounds, salt, digest = password_hash.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt.encode("utf-8"), int(rounds)
        ).hex()
        return hmac.compare_digest(candidate, digest)
    except Exception:
        return False


def json_dumps(data) -> bytes:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def send_email_code(to_email: str, code: str) -> None:
    """Send a verification code email. Raises on failure."""
    with connect() as conn:
        smtp_host = get_setting(conn, "smtp_host")
        smtp_port = get_setting(conn, "smtp_port")
        smtp_user = get_setting(conn, "smtp_user")
        smtp_pass = get_setting(conn, "smtp_pass")
        smtp_sender = get_setting(conn, "smtp_sender") or smtp_user
    if not smtp_host:
        raise RuntimeError("SMTP 未配置，请联系管理员设置邮箱服务")
    port = int(smtp_port or 465)
    msg = MIMEMultipart("alternative")
    msg["Subject"] = "PSL 产品选型 — 邮箱验证码"
    msg["From"] = smtp_sender
    msg["To"] = to_email
    html = f"""\
<html><body style="font-family:sans-serif;padding:20px;">
<h2 style="color:#136f63;">PSL 产品选型清单</h2>
<p>您的注册验证码是：</p>
<div style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#136f63;padding:12px 20px;background:#eef6f5;border-radius:6px;display:inline-block;">{code}</div>
<p style="color:#888;margin-top:16px;">验证码 {CODE_EXPIRE_MINUTES} 分钟内有效，请勿转发。</p>
</body></html>"""
    msg.attach(MIMEText(html, "html", "utf-8"))
    if port == 465:
        with smtplib.SMTP_SSL(smtp_host, port, timeout=8) as smtp:
            smtp.login(smtp_user, smtp_pass)
            smtp.sendmail(smtp_sender, [to_email], msg.as_string())
    else:
        with smtplib.SMTP(smtp_host, port, timeout=8) as smtp:
            smtp.starttls()
            smtp.login(smtp_user, smtp_pass)
            smtp.sendmail(smtp_sender, [to_email], msg.as_string())


def row_to_dict(row: sqlite3.Row) -> dict:
    return {key: row[key] for key in row.keys()}


def normalize_key(value) -> str:
    return str(value or "").strip().lower().replace(" ", "_").replace("-", "_")


def get_numeric(value):
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    cleaned = (
        text.replace(",", "")
        .replace("≥", "")
        .replace("≤", "")
        .replace(">", "")
        .replace("<", "")
        .replace("±", "")
    )
    number = ""
    for char in cleaned:
        if char.isdigit() or char in ".-":
            number += char
        elif number:
            break
    try:
        return float(number) if number not in {"", "-", "."} else None
    except ValueError:
        return None


def require_columns(row: dict, columns: list[str]) -> list[str]:
    return [column for column in columns if not str(row.get(column, "")).strip()]


def is_sensitive_parameter(parameter: dict) -> bool:
    text = " ".join(
        str(parameter.get(key, ""))
        for key in ("group_name", "name", "unit")
    ).lower()
    keywords = [
        "成本",
        "售价",
        "价格",
        "报价",
        "折扣",
        "bom",
        "cost",
        "price",
        "鎴愭湰",
        "鍞环",
    ]
    return any(keyword in text for keyword in keywords)


SCHEMA = """
CREATE TABLE IF NOT EXISTS user_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'editor', 'viewer')),
    password_hash TEXT NOT NULL,
    group_id INTEGER REFERENCES user_groups(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    series TEXT DEFAULT '',
    tag TEXT DEFAULT '',
    image_url TEXT DEFAULT '',
    manufacturer TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS parameter_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS parameters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES parameter_groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    unit TEXT DEFAULT '',
    data_type TEXT DEFAULT 'text',
    filterable INTEGER DEFAULT 0,
    sort_order INTEGER DEFAULT 0,
    UNIQUE(group_id, name, unit)
);

CREATE TABLE IF NOT EXISTS parameter_values (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    parameter_id INTEGER NOT NULL REFERENCES parameters(id) ON DELETE CASCADE,
    display_value TEXT DEFAULT '',
    numeric_value REAL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(product_id, parameter_id)
);

CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    type TEXT DEFAULT 'document',
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS import_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_name TEXT NOT NULL,
    status TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    target TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    code TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS system_settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
);
"""


SAMPLE_PRODUCTS = [
    {
        "code": "A-ZF0100",
        "name": "旋转线 I",
        "series": "翻箱倒料机器人",
        "tag": "食药级",
        "image_url": "",
        "manufacturer": "123Robot",
        "sort_order": 10,
        "values": {
            ("设备本体", "主体品牌", ""): "123Robot",
            ("基本参数", "长度", "mm"): "1434",
            ("基本参数", "宽度", "mm"): "834",
            ("基本参数", "高度", "mm"): "1365",
            ("基本参数", "设备重量", "kg"): "600",
            ("驱动特性", "最大速度-空载", "m/min"): "90",
            ("安全特性", "激光避障", ""): "360",
            ("电源特性", "电池类型", ""): "磷酸铁锂电池",
            ("售前支持", "BOM成本", "万元"): "6",
        },
    },
    {
        "code": "A-ZF0600",
        "name": "旋转线 II",
        "series": "翻箱倒料机器人",
        "tag": "食药级",
        "image_url": "",
        "manufacturer": "123Robot",
        "sort_order": 20,
        "values": {
            ("设备本体", "主体品牌", ""): "123Robot",
            ("基本参数", "长度", "mm"): "1660",
            ("基本参数", "宽度", "mm"): "1284",
            ("基本参数", "高度", "mm"): "1706",
            ("基本参数", "设备重量", "kg"): "860",
            ("驱动特性", "最大速度-空载", "m/min"): "90",
            ("安全特性", "激光避障", ""): "360",
            ("电源特性", "电池类型", ""): "磷酸铁锂电池",
            ("售前支持", "BOM成本", "万元"): "7.3",
        },
    },
    {
        "code": "A-KD0300",
        "name": "精灵线 I",
        "series": "潜伏机器人",
        "tag": "食药级",
        "image_url": "",
        "manufacturer": "123Robot",
        "sort_order": 30,
        "values": {
            ("设备本体", "主体品牌", ""): "123Robot",
            ("基本参数", "长度", "mm"): "800",
            ("基本参数", "宽度", "mm"): "550",
            ("基本参数", "高度", "mm"): "300",
            ("基本参数", "设备重量", "kg"): "200",
            ("驱动特性", "最大速度-空载", "m/min"): "90",
            ("安全特性", "激光避障", ""): "220",
            ("电源特性", "电池类型", ""): "磷酸铁锂电池",
            ("售前支持", "BOM成本", "万元"): "5",
        },
    },
    {
        "code": "A-KD1000",
        "name": "精灵线 III",
        "series": "潜伏机器人",
        "tag": "食药级",
        "image_url": "",
        "manufacturer": "123Robot",
        "sort_order": 40,
        "values": {
            ("设备本体", "主体品牌", ""): "123Robot",
            ("基本参数", "长度", "mm"): "1150",
            ("基本参数", "宽度", "mm"): "800",
            ("基本参数", "高度", "mm"): "300",
            ("基本参数", "设备重量", "kg"): "300",
            ("驱动特性", "最大速度-空载", "m/min"): "90",
            ("安全特性", "激光避障", ""): "220",
            ("电源特性", "电池类型", ""): "磷酸铁锂电池",
            ("售前支持", "BOM成本", "万元"): "5.6",
        },
    },
]


def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    UPLOAD_DIR.mkdir(exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        # Migration: add group_id column to users if missing
        cols = [r["name"] for r in conn.execute("PRAGMA table_info(users)").fetchall()]
        if "group_id" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN group_id INTEGER REFERENCES user_groups(id) ON DELETE SET NULL")
        if "email" not in cols:
            conn.execute("ALTER TABLE users ADD COLUMN email TEXT DEFAULT ''")
        # Migration: add used column to email_codes if missing (for older DBs)
        ec_cols = [r["name"] for r in conn.execute("PRAGMA table_info(email_codes)").fetchall()]
        if "used" not in ec_cols:
            conn.execute("ALTER TABLE email_codes ADD COLUMN used INTEGER DEFAULT 0")
        if "created_at" not in ec_cols:
            conn.execute("ALTER TABLE email_codes ADD COLUMN created_at TEXT NOT NULL DEFAULT ''")
        # Seed system_settings defaults if empty
        if conn.execute("SELECT COUNT(*) FROM system_settings").fetchone()[0] == 0:
            for k in (
                "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_sender",
                "storage_type", "upload_dir", "s3_endpoint", "s3_bucket", "s3_region",
                "s3_access_key", "s3_secret_key", "s3_custom_domain",
            ):
                conn.execute(
                    "INSERT OR IGNORE INTO system_settings(key, value) VALUES (?, '')",
                    (k,),
                )
            conn.execute("UPDATE system_settings SET value = 'local' WHERE key = 'storage_type'")
        # Seed default user group
        group_count = conn.execute("SELECT COUNT(*) FROM user_groups").fetchone()[0]
        if group_count == 0:
            conn.execute(
                "INSERT INTO user_groups(name, description, sort_order, created_at) VALUES (?, ?, ?, ?)",
                ("默认组", "系统默认用户组", 10, now_iso()),
            )
        # Assign existing users without a group to the default group
        default_group = conn.execute("SELECT id FROM user_groups WHERE name = ?", ("默认组",)).fetchone()
        if default_group:
            conn.execute("UPDATE users SET group_id = ? WHERE group_id IS NULL", (default_group["id"],))
        user_count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
        if user_count == 0:
            default_group = conn.execute("SELECT id FROM user_groups WHERE name = ?", ("默认组",)).fetchone()
            conn.execute(
                """
                INSERT INTO users(username, display_name, role, password_hash, group_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                ("admin", "系统管理员", "admin", hash_password("admin123"), default_group["id"] if default_group else None, now_iso()),
            )
        product_count = conn.execute("SELECT COUNT(*) FROM products").fetchone()[0]
        if product_count == 0:
            seed_sample_data(conn)


def seed_sample_data(conn: sqlite3.Connection) -> None:
    filterable_names = {"长度", "宽度", "高度", "设备重量", "最大速度-空载", "BOM成本"}
    for product in SAMPLE_PRODUCTS:
        product_id = upsert_product(conn, product)
        for key, value in product["values"].items():
            group, name, unit = key
            parameter_id = ensure_parameter(
                conn,
                group,
                name,
                unit,
                data_type="number" if name in filterable_names else "text",
                filterable=name in filterable_names,
            )
            upsert_value(conn, product_id, parameter_id, value)


def ensure_group(conn: sqlite3.Connection, name: str) -> int:
    name = name.strip() or "未分组"
    row = conn.execute("SELECT id FROM parameter_groups WHERE name = ?", (name,)).fetchone()
    if row:
        return row["id"]
    max_sort = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM parameter_groups").fetchone()[0]
    cursor = conn.execute(
        "INSERT INTO parameter_groups(name, sort_order) VALUES (?, ?)",
        (name, max_sort + 10),
    )
    return cursor.lastrowid


def ensure_parameter(
    conn: sqlite3.Connection,
    group_name: str,
    name: str,
    unit: str = "",
    data_type: str = "text",
    filterable: bool = False,
) -> int:
    group_id = ensure_group(conn, group_name)
    name = name.strip()
    unit = (unit or "").strip()
    row = conn.execute(
        "SELECT id FROM parameters WHERE group_id = ? AND name = ? AND unit = ?",
        (group_id, name, unit),
    ).fetchone()
    if row:
        if filterable:
            conn.execute(
                "UPDATE parameters SET filterable = 1, data_type = ? WHERE id = ?",
                (data_type, row["id"]),
            )
        return row["id"]
    max_sort = conn.execute(
        "SELECT COALESCE(MAX(sort_order), 0) FROM parameters WHERE group_id = ?",
        (group_id,),
    ).fetchone()[0]
    cursor = conn.execute(
        """
        INSERT INTO parameters(group_id, name, unit, data_type, filterable, sort_order)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (group_id, name, unit, data_type, 1 if filterable else 0, max_sort + 10),
    )
    return cursor.lastrowid


def upsert_product(conn: sqlite3.Connection, data: dict) -> int:
    code = str(data.get("code", "")).strip()
    if not code:
        raise ValueError("产品型号不能为空")
    existing = conn.execute("SELECT id FROM products WHERE code = ?", (code,)).fetchone()
    fields = {
        "name": str(data.get("name") or code).strip(),
        "series": str(data.get("series") or "").strip(),
        "tag": str(data.get("tag") or "").strip(),
        "image_url": str(data.get("image_url") or "").strip(),
        "manufacturer": str(data.get("manufacturer") or "").strip(),
        "status": str(data.get("status") or "active").strip(),
        "sort_order": int(data.get("sort_order") or 0),
        "updated_at": now_iso(),
    }
    if existing:
        conn.execute(
            """
            UPDATE products
            SET name = ?, series = ?, tag = ?, image_url = ?, manufacturer = ?,
                status = ?, sort_order = ?, updated_at = ?
            WHERE id = ?
            """,
            (*fields.values(), existing["id"]),
        )
        return existing["id"]
    cursor = conn.execute(
        """
        INSERT INTO products(code, name, series, tag, image_url, manufacturer, status,
                             sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            code,
            fields["name"],
            fields["series"],
            fields["tag"],
            fields["image_url"],
            fields["manufacturer"],
            fields["status"],
            fields["sort_order"],
            now_iso(),
            fields["updated_at"],
        ),
    )
    return cursor.lastrowid


def upsert_value(conn: sqlite3.Connection, product_id: int, parameter_id: int, value) -> None:
    display = "" if value is None else str(value).strip()
    conn.execute(
        """
        INSERT INTO parameter_values(product_id, parameter_id, display_value, numeric_value, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(product_id, parameter_id)
        DO UPDATE SET display_value = excluded.display_value,
                      numeric_value = excluded.numeric_value,
                      updated_at = excluded.updated_at
        """,
        (product_id, parameter_id, display, get_numeric(display), now_iso()),
    )


def log_audit(conn: sqlite3.Connection, user_id: int | None, action: str, target: str, detail: dict) -> None:
    conn.execute(
        """
        INSERT INTO audit_logs(user_id, action, target, detail, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (user_id, action, target, json.dumps(detail, ensure_ascii=False), now_iso()),
    )


def get_catalog(conn: sqlite3.Connection, can_view_sensitive: bool = False) -> dict:
    products = [
        row_to_dict(row)
        for row in conn.execute(
            """
            SELECT * FROM products
            ORDER BY sort_order ASC, series ASC, code ASC
            """
        )
    ]
    groups = [
        row_to_dict(row)
        for row in conn.execute(
            "SELECT * FROM parameter_groups ORDER BY sort_order ASC, id ASC"
        )
    ]
    parameters = [
        row_to_dict(row)
        for row in conn.execute(
            """
            SELECT p.*, g.name AS group_name
            FROM parameters p
            JOIN parameter_groups g ON g.id = p.group_id
            ORDER BY g.sort_order ASC, p.sort_order ASC, p.id ASC
            """
        )
    ]
    sensitive_parameter_ids = set()
    for parameter in parameters:
        sensitive = is_sensitive_parameter(parameter)
        parameter["sensitive"] = 1 if sensitive else 0
        if sensitive:
            sensitive_parameter_ids.add(parameter["id"])
    if not can_view_sensitive:
        parameters = [
            parameter
            for parameter in parameters
            if parameter["id"] not in sensitive_parameter_ids
        ]
    visible_parameter_ids = {parameter["id"] for parameter in parameters}
    values = {}
    for row in conn.execute("SELECT * FROM parameter_values"):
        if row["parameter_id"] not in visible_parameter_ids:
            continue
        values[f'{row["product_id"]}:{row["parameter_id"]}'] = row_to_dict(row)
    attachments = {}
    for row in conn.execute("SELECT * FROM attachments ORDER BY sort_order ASC, id ASC"):
        attachments.setdefault(str(row["product_id"]), []).append(row_to_dict(row))
    series = sorted({product["series"] for product in products if product["series"]})
    tags = sorted({product["tag"] for product in products if product["tag"]})
    return {
        "products": products,
        "groups": groups,
        "parameters": parameters,
        "values": values,
        "attachments": attachments,
        "filters": {"series": series, "tags": tags},
        "can_view_sensitive": can_view_sensitive,
    }


def parse_spreadsheet(file_name: str, content: bytes) -> list[list[str]]:
    suffix = Path(file_name).suffix.lower()
    if suffix in {".xlsx", ".xlsm"}:
        if openpyxl is None:
            raise ValueError("当前 Python 环境缺少 openpyxl，无法解析 xlsx")
        workbook = openpyxl.load_workbook(io.BytesIO(content), data_only=True)
        sheet = workbook.active
        rows = []
        for row in sheet.iter_rows(values_only=True):
            rows.append(["" if cell is None else str(cell).strip() for cell in row])
        return rows
    text = content.decode("utf-8-sig")
    return [[cell.strip() for cell in row] for row in csv.reader(io.StringIO(text))]


def import_rows(conn: sqlite3.Connection, rows: list[list[str]], user_id: int | None) -> dict:
    rows = [row for row in rows if any(str(cell).strip() for cell in row)]
    if not rows:
        raise ValueError("文件为空")
    header = [normalize_key(cell) for cell in rows[0]]
    long_keys = {"code", "product_code", "型号", "产品型号"}
    if any(key in header for key in long_keys) and any(key in header for key in {"parameter", "参数", "参数项"}):
        summary = import_long_table(conn, rows, user_id)
    else:
        summary = import_matrix_table(conn, rows, user_id)
    return summary


def value_from(row: dict, *keys, default=""):
    for key in keys:
        if key in row and str(row[key]).strip():
            return str(row[key]).strip()
    return default


def import_long_table(conn: sqlite3.Connection, rows: list[list[str]], user_id: int | None) -> dict:
    header = [normalize_key(cell) for cell in rows[0]]
    stats = {"products": 0, "parameters": 0, "values": 0, "rows": max(len(rows) - 1, 0)}
    seen_products = set()
    seen_params = set()
    for raw in rows[1:]:
        padded = raw + [""] * max(0, len(header) - len(raw))
        row = dict(zip(header, padded))
        code = value_from(row, "code", "product_code", "产品型号", "型号")
        parameter_name = value_from(row, "parameter", "参数", "参数项", "name")
        if not code or not parameter_name:
            continue
        product_id = upsert_product(
            conn,
            {
                "code": code,
                "name": value_from(row, "product_name", "产品名称", default=code),
                "series": value_from(row, "series", "产品系列"),
                "tag": value_from(row, "tag", "产品标签"),
                "image_url": value_from(row, "image_url", "图片", "产品图片"),
                "manufacturer": value_from(row, "manufacturer", "厂家", "主体品牌"),
                "status": value_from(row, "status", "状态", default="active"),
                "sort_order": int(float(value_from(row, "sort_order", "排序", default="0") or 0)),
            },
        )
        if code not in seen_products:
            stats["products"] += 1
            seen_products.add(code)
        parameter_id = ensure_parameter(
            conn,
            value_from(row, "group", "分组", default="未分组"),
            parameter_name,
            value_from(row, "unit", "单位"),
            data_type=value_from(row, "data_type", "类型", default="number")
            if value_from(row, "numeric_value", "数值")
            else "text",
            filterable=value_from(row, "filterable", "可筛选", default="").lower() in {"1", "true", "是", "yes", "y"},
        )
        param_key = f"{parameter_id}"
        if param_key not in seen_params:
            stats["parameters"] += 1
            seen_params.add(param_key)
        upsert_value(conn, product_id, parameter_id, value_from(row, "value", "参数值", "display_value", "值"))
        stats["values"] += 1
    log_audit(conn, user_id, "import", "long_table", stats)
    return stats


def import_matrix_table(conn: sqlite3.Connection, rows: list[list[str]], user_id: int | None) -> dict:
    header = rows[0]
    if len(header) < 4:
        raise ValueError("矩阵模板至少需要：分组、参数、单位，以及一个产品型号列")
    product_codes = [cell.strip() for cell in header[3:] if cell.strip()]
    if not product_codes:
        raise ValueError("未识别到产品型号列")
    product_ids = {}
    stats = {"products": 0, "parameters": 0, "values": 0, "rows": max(len(rows) - 1, 0)}
    for offset, code in enumerate(product_codes):
        product_ids[offset] = upsert_product(conn, {"code": code, "name": code, "sort_order": (offset + 1) * 10})
        stats["products"] += 1
    current_group = "未分组"
    for raw in rows[1:]:
        row = raw + [""] * max(0, len(header) - len(raw))
        group, name, unit = (row[0].strip(), row[1].strip(), row[2].strip())
        if group:
            current_group = group
        if not name:
            continue
        if name in {"产品名称", "名称", "产品系列", "系列", "产品标签", "标签", "厂家", "主体品牌", "产品图片"}:
            for offset, value in enumerate(row[3:3 + len(product_codes)]):
                code = product_codes[offset]
                if not value:
                    continue
                field_map = {
                    "产品名称": "name",
                    "名称": "name",
                    "产品系列": "series",
                    "系列": "series",
                    "产品标签": "tag",
                    "标签": "tag",
                    "厂家": "manufacturer",
                    "主体品牌": "manufacturer",
                    "产品图片": "image_url",
                }
                existing = conn.execute("SELECT * FROM products WHERE code = ?", (code,)).fetchone()
                data = row_to_dict(existing)
                data[field_map[name]] = value
                upsert_product(conn, data)
            continue
        parameter_id = ensure_parameter(
            conn,
            current_group,
            name,
            unit,
            data_type="number" if any(get_numeric(value) is not None for value in row[3:]) else "text",
            filterable=name in {"长度", "宽度", "高度", "设备重量", "最大速度-空载", "BOM成本", "标准售价"},
        )
        stats["parameters"] += 1
        for offset, value in enumerate(row[3:3 + len(product_codes)]):
            if value == "":
                continue
            upsert_value(conn, product_ids[offset], parameter_id, value)
            stats["values"] += 1
    log_audit(conn, user_id, "import", "matrix_table", stats)
    return stats


def parse_multipart(content_type: str, body: bytes) -> dict:
    marker = "boundary="
    if marker not in content_type:
        raise ValueError("上传请求缺少 boundary")
    boundary = content_type.split(marker, 1)[1].strip().strip('"').encode("utf-8")
    fields = {}
    for part in body.split(b"--" + boundary):
        part = part.strip()
        if not part or part == b"--":
            continue
        if part.endswith(b"--"):
            part = part[:-2].strip()
        if b"\r\n\r\n" not in part:
            continue
        header_blob, payload = part.split(b"\r\n\r\n", 1)
        headers = header_blob.decode("utf-8", errors="ignore").split("\r\n")
        disposition = next((h for h in headers if h.lower().startswith("content-disposition")), "")
        attrs = {}
        for chunk in disposition.split(";"):
            if "=" in chunk:
                key, value = chunk.strip().split("=", 1)
                attrs[key.lower()] = value.strip().strip('"')
        name = attrs.get("name")
        if not name:
            continue
        fields[name] = {"filename": attrs.get("filename", ""), "content": payload.rstrip(b"\r\n")}
    return fields


class AppHandler(BaseHTTPRequestHandler):
    server_version = "PSLSelection/0.1"

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))

    def send_json(self, data, status=HTTPStatus.OK):
        payload = json_dumps(data)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_error_json(self, message, status=HTTPStatus.BAD_REQUEST):
        self.send_json({"error": message}, status)

    def read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if not length:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def current_user(self):
        auth = self.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            token = auth.split(" ", 1)[1]
            session = SESSIONS.get(token)
            if session:
                return session
        return None

    def require_user(self):
        user = self.current_user()
        if not user:
            self.send_error_json("请先登录", HTTPStatus.UNAUTHORIZED)
            return None
        return user

    def require_role(self, *roles):
        user = self.require_user()
        if not user:
            return None
        if user["role"] not in roles:
            self.send_error_json("当前账号没有操作权限", HTTPStatus.FORBIDDEN)
            return None
        return user

    def do_GET(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/api/catalog":
                user = self.current_user()
                with connect() as conn:
                    self.send_json(get_catalog(conn, can_view_sensitive=bool(user)))
                return
            if path == "/api/me":
                user = self.current_user()
                self.send_json({"user": user})
                return
            if path == "/api/audit":
                user = self.require_user()
                if not user:
                    return
                with connect() as conn:
                    rows = [
                        row_to_dict(row)
                        for row in conn.execute(
                            """
                            SELECT a.*, u.display_name
                            FROM audit_logs a
                            LEFT JOIN users u ON u.id = a.user_id
                            ORDER BY a.id DESC
                            LIMIT 80
                            """
                        )
                    ]
                self.send_json({"logs": rows})
                return
            if path == "/api/user-groups":
                user = self.require_role("admin")
                if not user:
                    return
                with connect() as conn:
                    rows = [
                        row_to_dict(row)
                        for row in conn.execute(
                            """
                            SELECT g.id, g.name, g.description, g.sort_order, g.created_at,
                                   COUNT(u.id) AS member_count
                            FROM user_groups g
                            LEFT JOIN users u ON u.group_id = g.id
                            GROUP BY g.id
                            ORDER BY g.sort_order ASC, g.id ASC
                            """
                        )
                    ]
                self.send_json({"groups": rows})
                return
            if path == "/api/users":
                user = self.require_role("admin")
                if not user:
                    return
                with connect() as conn:
                    rows = [
                        row_to_dict(row)
                        for row in conn.execute(
                            """
                            SELECT u.id, u.username, u.display_name, u.role, u.group_id, u.created_at,
                                   COALESCE(g.name, '') AS group_name
                            FROM users u
                            LEFT JOIN user_groups g ON g.id = u.group_id
                            ORDER BY u.id ASC
                            """
                        )
                    ]
                self.send_json({"users": rows})
                return
            if path == "/api/template.csv":
                if not self.require_role("admin"):
                    return
                self.send_response(HTTPStatus.OK)
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", 'attachment; filename="psl-import-template.csv"')
                self.end_headers()
                self.wfile.write(make_template_csv())
                return
            if path == "/api/settings":
                if not self.require_role("admin"):
                    return
                with connect() as conn:
                    rows = conn.execute("SELECT key, value FROM system_settings ORDER BY key").fetchall()
                    settings = {row["key"]: row["value"] for row in rows}
                self.send_json({"settings": settings})
                return
            self.serve_static(path)
        except Exception as exc:
            traceback.print_exc()
            self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self):
        try:
            parsed = urlparse(self.path)
            path = parsed.path
            if path == "/api/send-register-code":
                data = self.read_json()
                email = (data.get("email") or "").strip().lower()
                if not email or "@" not in email or "." not in email:
                    self.send_error_json("请输入有效的邮箱地址")
                    return
                with connect() as conn:
                    # Check if email already registered
                    existing = conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone()
                    if existing:
                        self.send_error_json("该邮箱已被注册")
                        return
                    # Rate limit: check last code sent within CODE_RATE_LIMIT_SECONDS
                    last = conn.execute(
                        "SELECT id, created_at FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1",
                        (email,),
                    ).fetchone()
                    if last:
                        last_time = datetime.fromisoformat(last["created_at"]).replace(tzinfo=None)
                        now = datetime.now(timezone.utc).astimezone().replace(tzinfo=None)
                        elapsed = (now - last_time).total_seconds()
                        if elapsed < CODE_RATE_LIMIT_SECONDS:
                            self.send_error_json(f"请 {int(CODE_RATE_LIMIT_SECONDS - elapsed)} 秒后再试")
                            return
                    # Generate code and store
                    code = str(secrets.randbelow(900000) + 100000)  # 6-digit
                    expires_at = datetime.now(timezone.utc).astimezone().replace(tzinfo=None)
                    expires_at = (expires_at + timedelta(minutes=CODE_EXPIRE_MINUTES)).isoformat(timespec="seconds")
                    conn.execute(
                        "INSERT INTO email_codes(email, code, expires_at, created_at) VALUES (?, ?, ?, ?)",
                        (email, code, expires_at, now_iso()),
                    )
                try:
                    send_email_code(email, code)
                except Exception as exc:
                    self.send_error_json(f"邮件发送失败：{exc}")
                    return
                self.send_json({"ok": True, "message": "验证码已发送，请查收邮件"})
                return
            if path == "/api/register":
                data = self.read_json()
                email = (data.get("email") or "").strip().lower()
                code = (data.get("code") or "").strip()
                username = (data.get("username") or "").strip()
                display_name = (data.get("display_name") or "").strip()
                password = (data.get("password") or "").strip()
                if not email or not code or not username or not display_name or not password:
                    self.send_error_json("请填写所有字段")
                    return
                if len(password) < 6:
                    self.send_error_json("密码至少 6 位")
                    return
                with connect() as conn:
                    # Verify code
                    now_naive = datetime.now(timezone.utc).astimezone().replace(tzinfo=None).isoformat(timespec="seconds")
                    row = conn.execute(
                        "SELECT id, code, expires_at, used FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1",
                        (email,),
                    ).fetchone()
                    if not row:
                        self.send_error_json("请先获取验证码")
                        return
                    if row["used"]:
                        self.send_error_json("验证码已使用，请重新获取")
                        return
                    if row["expires_at"] < now_naive:
                        self.send_error_json("验证码已过期，请重新获取")
                        return
                    if row["code"] != code:
                        self.send_error_json("验证码错误")
                        return
                    # Mark code as used
                    conn.execute("UPDATE email_codes SET used = 1 WHERE id = ?", (row["id"],))
                    # Check username uniqueness
                    if conn.execute("SELECT id FROM users WHERE username = ?", (username,)).fetchone():
                        self.send_error_json("该用户名已被占用")
                        return
                    if conn.execute("SELECT id FROM users WHERE email = ?", (email,)).fetchone():
                        self.send_error_json("该邮箱已被注册")
                        return
                    # Get default group
                    default_group = conn.execute(
                        "SELECT id FROM user_groups ORDER BY sort_order ASC, id ASC LIMIT 1"
                    ).fetchone()
                    group_id = default_group["id"] if default_group else None
                    # Create user
                    cursor = conn.execute(
                        """
                        INSERT INTO users(username, display_name, role, password_hash, email, group_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            username,
                            display_name,
                            "viewer",
                            hash_password(password),
                            email,
                            group_id,
                            now_iso(),
                        ),
                    )
                    new_id = cursor.lastrowid
                    log_audit(conn, new_id, "register", f"user:{new_id}", {"email": email, "username": username})
                # Auto login
                token = secrets.token_urlsafe(32)
                user = {
                    "id": new_id,
                    "username": username,
                    "display_name": display_name,
                    "role": "viewer",
                }
                SESSIONS[token] = user
                self.send_json({"token": token, "user": user})
                return
            if path == "/api/login":
                data = self.read_json()
                with connect() as conn:
                    row = conn.execute("SELECT * FROM users WHERE username = ?", (data.get("username"),)).fetchone()
                if not row or not verify_password(data.get("password", ""), row["password_hash"]):
                    self.send_error_json("账号或密码错误", HTTPStatus.UNAUTHORIZED)
                    return
                token = secrets.token_urlsafe(32)
                user = {
                    "id": row["id"],
                    "username": row["username"],
                    "display_name": row["display_name"],
                    "role": row["role"],
                }
                SESSIONS[token] = user
                self.send_json({"token": token, "user": user})
                return
            if path == "/api/logout":
                auth = self.headers.get("Authorization", "")
                if auth.startswith("Bearer "):
                    SESSIONS.pop(auth.split(" ", 1)[1], None)
                self.send_json({"ok": True})
                return
            if path == "/api/products":
                user = self.require_user()
                if not user:
                    return
                data = self.read_json()
                with connect() as conn:
                    product_id = upsert_product(conn, data)
                    log_audit(conn, user["id"], "save_product", f"product:{product_id}", data)
                self.send_json({"id": product_id})
                return
            if path == "/api/parameters":
                user = self.require_user()
                if not user:
                    return
                data = self.read_json()
                with connect() as conn:
                    parameter_id = ensure_parameter(
                        conn,
                        data.get("group_name", "未分组"),
                        data.get("name", ""),
                        data.get("unit", ""),
                        data.get("data_type", "text"),
                        bool(data.get("filterable")),
                    )
                    log_audit(conn, user["id"], "save_parameter", f"parameter:{parameter_id}", data)
                self.send_json({"id": parameter_id})
                return
            if path == "/api/upload":
                user = self.require_user()
                if not user:
                    return
                self.handle_upload(user)
                return
            if path == "/api/user-groups":
                user = self.require_role("admin")
                if not user:
                    return
                data = self.read_json()
                name = (data.get("name") or "").strip()
                if not name:
                    self.send_error_json("用户组名称不能为空")
                    return
                with connect() as conn:
                    max_sort = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM user_groups").fetchone()[0]
                    cursor = conn.execute(
                        """
                        INSERT INTO user_groups(name, description, sort_order, created_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (name, data.get("description", "").strip(), max_sort + 10, now_iso()),
                    )
                    log_audit(conn, user["id"], "create_user_group", f"group:{cursor.lastrowid}", {"name": name})
                self.send_json({"id": cursor.lastrowid})
                return
            if path == "/api/users":
                user = self.require_role("admin")
                if not user:
                    return
                data = self.read_json()
                missing = require_columns(data, ["username", "password"])
                if missing:
                    self.send_error_json(f"缺少字段：{', '.join(missing)}")
                    return
                role = data.get("role", "viewer")
                if role not in {"admin", "editor", "viewer"}:
                    self.send_error_json("角色必须是 admin、editor 或 viewer")
                    return
                group_id = data.get("group_id")
                with connect() as conn:
                    if group_id:
                        group_id = int(group_id)
                        if not conn.execute("SELECT id FROM user_groups WHERE id = ?", (group_id,)).fetchone():
                            self.send_error_json("用户组不存在")
                            return
                    else:
                        group_id = None
                    cursor = conn.execute(
                        """
                        INSERT INTO users(username, display_name, role, password_hash, group_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            data["username"].strip(),
                            data.get("display_name", data["username"]).strip() or data["username"].strip(),
                            role,
                            hash_password(data["password"]),
                            group_id,
                            now_iso(),
                        ),
                    )
                    log_audit(conn, user["id"], "create_user", f"user:{cursor.lastrowid}", {"username": data["username"], "role": role})
                self.send_json({"id": cursor.lastrowid})
                return
            self.send_error_json("接口不存在", HTTPStatus.NOT_FOUND)
        except Exception as exc:
            traceback.print_exc()
            self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_PUT(self):
        try:
            user = self.require_user()
            if not user:
                return
            parsed = urlparse(self.path)
            path = parsed.path
            data = self.read_json()
            with connect() as conn:
                if path.startswith("/api/products/"):
                    product_id = int(path.rsplit("/", 1)[1])
                    existing = conn.execute("SELECT * FROM products WHERE id = ?", (product_id,)).fetchone()
                    if not existing:
                        self.send_error_json("产品不存在", HTTPStatus.NOT_FOUND)
                        return
                    payload = row_to_dict(existing)
                    payload.update(data)
                    payload["code"] = existing["code"]
                    upsert_product(conn, payload)
                    log_audit(conn, user["id"], "update_product", f"product:{product_id}", data)
                    self.send_json({"ok": True})
                    return
                if path.startswith("/api/values/"):
                    _, _, _, product_id, parameter_id = path.split("/")
                    upsert_value(conn, int(product_id), int(parameter_id), data.get("display_value", ""))
                    log_audit(
                        conn,
                        user["id"],
                        "update_value",
                        f"value:{product_id}:{parameter_id}",
                        data,
                    )
                    self.send_json({"ok": True})
                    return
                if path.startswith("/api/parameters/"):
                    parameter_id = int(path.rsplit("/", 1)[1])
                    existing = conn.execute(
                        """
                        SELECT p.*, g.name AS group_name
                        FROM parameters p
                        JOIN parameter_groups g ON g.id = p.group_id
                        WHERE p.id = ?
                        """,
                        (parameter_id,),
                    ).fetchone()
                    if not existing:
                        self.send_error_json("参数不存在", HTTPStatus.NOT_FOUND)
                        return
                    group_name = str(data.get("group_name", existing["group_name"])).strip()
                    group_id = ensure_group(conn, group_name)
                    conn.execute(
                        """
                        UPDATE parameters
                        SET group_id = ?, name = ?, unit = ?, data_type = ?,
                            filterable = ?, sort_order = ?
                        WHERE id = ?
                        """,
                        (
                            group_id,
                            str(data.get("name", existing["name"])).strip(),
                            str(data.get("unit", existing["unit"] or "")).strip(),
                            str(data.get("data_type", existing["data_type"] or "text")).strip(),
                            1 if data.get("filterable") else 0,
                            int(data.get("sort_order", existing["sort_order"] or 0) or 0),
                            parameter_id,
                        ),
                    )
                    log_audit(conn, user["id"], "update_parameter", f"parameter:{parameter_id}", data)
                    self.send_json({"ok": True})
                    return
                if path.startswith("/api/groups/"):
                    group_id = int(path.rsplit("/", 1)[1])
                    existing = conn.execute(
                        "SELECT * FROM parameter_groups WHERE id = ?", (group_id,)
                    ).fetchone()
                    if not existing:
                        self.send_error_json("分组不存在", HTTPStatus.NOT_FOUND)
                        return
                    conn.execute(
                        "UPDATE parameter_groups SET sort_order = ? WHERE id = ?",
                        (int(data.get("sort_order", existing["sort_order"] or 0) or 0), group_id),
                    )
                    log_audit(conn, user["id"], "update_group", f"group:{group_id}", data)
                    self.send_json({"ok": True})
                    return
                if path.startswith("/api/user-groups/"):
                    if user["role"] != "admin":
                        self.send_error_json("当前账号没有操作权限", HTTPStatus.FORBIDDEN)
                        return
                    group_id = int(path.rsplit("/", 1)[1])
                    existing = conn.execute("SELECT * FROM user_groups WHERE id = ?", (group_id,)).fetchone()
                    if not existing:
                        self.send_error_json("用户组不存在", HTTPStatus.NOT_FOUND)
                        return
                    name = (data.get("name") or existing["name"]).strip()
                    if not name:
                        self.send_error_json("用户组名称不能为空")
                        return
                    conn.execute(
                        """
                        UPDATE user_groups
                        SET name = ?, description = ?, sort_order = ?
                        WHERE id = ?
                        """,
                        (
                            name,
                            (data.get("description") or existing["description"]).strip(),
                            int(data.get("sort_order", existing["sort_order"] or 0) or 0),
                            group_id,
                        ),
                    )
                    log_audit(conn, user["id"], "update_user_group", f"group:{group_id}", data)
                    self.send_json({"ok": True})
                    return
                if path.startswith("/api/users/"):
                    if user["role"] != "admin":
                        self.send_error_json("当前账号没有操作权限", HTTPStatus.FORBIDDEN)
                        return
                    target_id = int(path.rsplit("/", 1)[1])
                    existing = conn.execute("SELECT * FROM users WHERE id = ?", (target_id,)).fetchone()
                    if not existing:
                        self.send_error_json("用户不存在", HTTPStatus.NOT_FOUND)
                        return
                    username = data.get("username", existing["username"]).strip()
                    if not username:
                        self.send_error_json("账号不能为空")
                        return
                    duplicate = conn.execute(
                        "SELECT id FROM users WHERE username = ? AND id <> ?",
                        (username, target_id),
                    ).fetchone()
                    if duplicate:
                        self.send_error_json("账号已存在")
                        return
                    display_name = data.get("display_name", username).strip() or username
                    role = data.get("role", existing["role"])
                    if role not in {"admin", "editor", "viewer"}:
                        self.send_error_json("角色必须是 admin、editor 或 viewer")
                        return
                    group_id = data.get("group_id", existing["group_id"])
                    if group_id is not None:
                        group_id = int(group_id)
                        if not conn.execute("SELECT id FROM user_groups WHERE id = ?", (group_id,)).fetchone():
                            group_id = None
                    else:
                        group_id = None
                    if data.get("password"):
                        conn.execute(
                            """
                            UPDATE users
                            SET username = ?, display_name = ?, role = ?, password_hash = ?, group_id = ?
                            WHERE id = ?
                            """,
                            (
                                username,
                                display_name,
                                role,
                                hash_password(data["password"]),
                                group_id,
                                target_id,
                            ),
                        )
                    else:
                        conn.execute(
                            "UPDATE users SET username = ?, display_name = ?, role = ?, group_id = ? WHERE id = ?",
                            (username, display_name, role, group_id, target_id),
                        )
                    log_audit(conn, user["id"], "update_user", f"user:{target_id}", {"role": role})
                    self.send_json({"ok": True})
                    return
                if path == "/api/settings":
                    if user["role"] != "admin":
                        self.send_error_json("当前账号没有操作权限", HTTPStatus.FORBIDDEN)
                        return
                    for key in (
                        "smtp_host", "smtp_port", "smtp_user", "smtp_pass", "smtp_sender",
                        "storage_type", "upload_dir", "s3_endpoint", "s3_bucket", "s3_region",
                        "s3_access_key", "s3_secret_key", "s3_custom_domain",
                    ):
                        if key in data:
                            set_setting(conn, key, str(data.get(key, "")).strip())
                    log_audit(conn, user["id"], "update_settings", "system_settings", {k: data.get(k, "***") for k in data})
                    self.send_json({"ok": True})
                    return
            self.send_error_json("接口不存在", HTTPStatus.NOT_FOUND)
        except Exception as exc:
            traceback.print_exc()
            self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_DELETE(self):
        try:
            user = self.require_user()
            if not user:
                return
            parsed = urlparse(self.path)
            path = parsed.path
            with connect() as conn:
                if path.startswith("/api/products/"):
                    product_id = int(path.rsplit("/", 1)[1])
                    conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
                    log_audit(conn, user["id"], "delete_product", f"product:{product_id}", {})
                    self.send_json({"ok": True})
                    return
                if path.startswith("/api/parameters/"):
                    parameter_id = int(path.rsplit("/", 1)[1])
                    conn.execute("DELETE FROM parameters WHERE id = ?", (parameter_id,))
                    log_audit(conn, user["id"], "delete_parameter", f"parameter:{parameter_id}", {})
                    self.send_json({"ok": True})
                    return
                if path.startswith("/api/user-groups/"):
                    if user["role"] != "admin":
                        self.send_error_json("当前账号没有操作权限", HTTPStatus.FORBIDDEN)
                        return
                    group_id = int(path.rsplit("/", 1)[1])
                    existing = conn.execute("SELECT id, name FROM user_groups WHERE id = ?", (group_id,)).fetchone()
                    if not existing:
                        self.send_error_json("用户组不存在", HTTPStatus.NOT_FOUND)
                        return
                    conn.execute("DELETE FROM user_groups WHERE id = ?", (group_id,))
                    log_audit(conn, user["id"], "delete_user_group", f"group:{group_id}", {"name": existing["name"]})
                    self.send_json({"ok": True})
                    return
                if path.startswith("/api/users/"):
                    if user["role"] != "admin":
                        self.send_error_json("当前账号没有操作权限", HTTPStatus.FORBIDDEN)
                        return
                    target_id = int(path.rsplit("/", 1)[1])
                    if target_id == user["id"]:
                        self.send_error_json("不能删除当前登录账号")
                        return
                    conn.execute("DELETE FROM users WHERE id = ?", (target_id,))
                    log_audit(conn, user["id"], "delete_user", f"user:{target_id}", {})
                    self.send_json({"ok": True})
                    return
            self.send_error_json("接口不存在", HTTPStatus.NOT_FOUND)
        except Exception as exc:
            traceback.print_exc()
            self.send_error_json(str(exc), HTTPStatus.INTERNAL_SERVER_ERROR)

    def handle_upload(self, user: dict) -> None:
        content_type = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length", "0"))
        fields = parse_multipart(content_type, self.rfile.read(length))
        file_field = fields.get("file")
        if not file_field or not file_field["filename"]:
            self.send_error_json("请选择要上传的 CSV 或 XLSX 文件")
            return
        filename = Path(file_field["filename"]).name
        content = file_field["content"]
        saved = UPLOAD_DIR / f"{datetime.now().strftime('%Y%m%d%H%M%S')}_{filename}"
        saved.write_bytes(content)
        with connect() as conn:
            try:
                rows = parse_spreadsheet(filename, content)
                summary = import_rows(conn, rows, user["id"])
                status = "success"
            except Exception as exc:
                summary = {"error": str(exc)}
                status = "failed"
            conn.execute(
                """
                INSERT INTO import_jobs(file_name, status, summary, created_by, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (filename, status, json.dumps(summary, ensure_ascii=False), user["id"], now_iso()),
            )
        if status == "failed":
            self.send_error_json(summary["error"])
        else:
            self.send_json({"summary": summary})

    def serve_static(self, path: str) -> None:
        if path in {"", "/"}:
            target = STATIC_DIR / "index.html"
        else:
            target = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR not in target.parents and target != STATIC_DIR:
            self.send_error(HTTPStatus.FORBIDDEN)
            return
        if not target.exists() or not target.is_file():
            target = STATIC_DIR / "index.html"
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        data = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def make_template_csv() -> bytes:
    rows = [["group", "parameter", "unit"] + [row["code"] for row in _recent_products()]]
    with connect() as conn:
        for param_row in conn.execute(
            """
            SELECT g.name AS group_name, p.name, p.unit
            FROM parameters p
            JOIN parameter_groups g ON g.id = p.group_id
            ORDER BY g.sort_order ASC, p.sort_order ASC
            LIMIT 20
            """
        ):
            rows.append([param_row["group_name"], param_row["name"], param_row["unit"] or ""])
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerows(rows)
    return output.getvalue().encode("utf-8-sig")


def _recent_products(limit: int = 20) -> list[dict]:
    with connect() as conn:
        return [
            row_to_dict(row)
            for row in conn.execute(
                "SELECT code FROM products ORDER BY sort_order ASC LIMIT ?", (limit,)
            )
        ]


def main() -> None:
    init_db()
    port = int(os.environ.get("PORT", "8765"))
    server = ThreadingHTTPServer(("127.0.0.1", port), AppHandler)
    print(f"PSL product selection app running at http://127.0.0.1:{port}")
    print("Default admin: admin / admin123")
    server.serve_forever()


if __name__ == "__main__":
    main()
