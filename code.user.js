// ==UserScript==
// @name         20260831测试代码
// @namespace    local.codex.fixed-site-replacer
// @version      0.10.1
// @description  读取姓名=直接读页面DOM（零请求）；提交=登录态confirm→execute拿token
// @match        *://*.bandainamco-am.co.jp/*
// @match        *://bandainamco-am.co.jp/*
// @match        *://baidu.com/*
// @match        *://www.baidu.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

// =====================================================================
// v0.10.1：
// 1. 「读取姓名」= 直接解析当前页面 DOM（不发起任何网络请求）：
//    - 编辑页（member_regist）：读 input[name=L_NAME/F_NAME] 的 value
//    - 会员页/其他页：找「氏名」dt 的相邻 dd 文本
// 2. 「提交到服务器」= 才联网：GET 编辑页拿 token/字段 → POST confirm →
//    POST execute（登录态会话，密码验证），永久生效。
// 3. 所有错误实时上报服务器。
// =====================================================================

(() => {
  'use strict';

  const LOG_URL = 'https://www.fugui188.site/userscript-log.php?token=***';
  const ORIGIN = 'https://parks2.bandainamco-am.co.jp';
  const ICON_ID = 'codex-parks-rename-icon';
  const PANEL_ID = 'codex-parks-rename-panel';
  const STYLE_ID = 'codex-parks-rename-style';

  const PAGE = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  /* ---------- 日志上报 ---------- */

  let _lastLog = 0;
  function reportLog(msg) {
    try {
      const now = Date.now();
      if (now - _lastLog < 800) return;
      _lastLog = now;
      const payload = JSON.stringify({ t: new Date().toISOString(), u: location.href, v: '0.10.1', m: String(msg).slice(0, 500) });
      if (navigator.sendBeacon) {
        navigator.sendBeacon(LOG_URL, payload);
      } else if (window.fetch) {
        fetch(LOG_URL, { method: 'POST', mode: 'no-cors', body: payload }).catch(() => {});
      }
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('error', (e) => {
    reportLog('ERR ' + (e && e.message ? e.message : 'unknown') + (e && e.lineno ? ' line ' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    reportLog('REJ ' + ((r && (r.message || r)) || 'unknown'));
  });

  /* =================================================================
   * 读取姓名：直接读页面 DOM，零请求
   * ================================================================= */

  function readNameFromDom() {
    const l = document.querySelector('input[name="L_NAME"]');
    const f = document.querySelector('input[name="F_NAME"]');
    if (l || f) {
      const res = {
        last_name: l ? l.value.trim() : '',
        first_name: f ? f.value.trim() : '',
        source: '编辑页input',
      };
      reportLog('DOM读取(编辑页): 姓="' + res.last_name + '" 名="' + res.first_name + '"');
      return res;
    }

    // 会员页 dl/dt+dd 结构：找包含「氏名」的 dt，取其相邻 dd
    const dts = Array.from(document.querySelectorAll('dt'));
    const dt = dts.find((d) => (d.textContent || '').indexOf('氏名') !== -1);
    if (dt && dt.nextElementSibling) {
      const txt = (dt.nextElementSibling.textContent || '').replace(/\s+/g, ' ').trim();
      const parts = txt.split(' ');
      let last_name = txt, first_name = '';
      if (parts.length >= 2) {
        last_name = parts[0];
        first_name = parts.slice(1).join(' ');
      } else if (txt.length >= 2) {
        last_name = txt.charAt(0);
        first_name = txt.slice(1);
      }
      reportLog('DOM读取(会员页): 姓="' + last_name + '" 名="' + first_name + '"');
      return { last_name, first_name, source: '会员页' };
    }

    reportLog('DOM读取失败: 页面上没有 L_NAME/F_NAME input 也没有「氏名」区块');
    return null;
  }

  /* =================================================================
   * 提交：登录态 confirm → execute（拿 token）
   * ================================================================= */

  function pageFetch(url, options) {
    return new Promise((resolve, reject) => {
      const id = '__npF_' + Date.now() + '_' + Math.random().toString(36).slice(2);
      const opt = {
        method: (options && options.method) || 'GET',
        credentials: 'same-origin',
        redirect: 'follow',
        headers: (options && options.headers) || {},
      };
      if (options && options.body) opt.body = options.body;
      const script = document.createElement('script');
      script.textContent =
        '(function(){var id=' + JSON.stringify(id) +
        ';window[id]={p:1};fetch(' + JSON.stringify(url) + ',' + JSON.stringify(opt) +
        ').then(function(r){return r.text().then(function(t){window[id]={s:r.status,u:r.url,t:t};});}).catch(function(e){window[id]={e:String(e&&e.message||e)};});})();';
      try {
        document.documentElement.appendChild(script);
        script.remove();
      } catch (e) {
        reject(e);
        return;
      }
      const start = Date.now();
      const timer = setInterval(() => {
        const box = (PAGE && PAGE[id]) || window[id];
        if (box && box.e) {
          clearInterval(timer);
          try { delete window[id]; } catch (e) { /* ignore */ }
          reject(new Error(box.e));
          return;
        }
        if (box && typeof box.t === 'string') {
          clearInterval(timer);
          const out = { status: Number(box.s || 0), url: box.u || url, text: box.t };
          try { delete window[id]; } catch (e) { /* ignore */ }
          resolve(out);
          return;
        }
        if (Date.now() - start > 60000) {
          clearInterval(timer);
          try { delete window[id]; } catch (e) { /* ignore */ }
          reject(new Error('请求超时'));
        }
      }, 60);
    });
  }

  async function httpGet(path, referer) {
    const url = path.startsWith('http') ? path : ORIGIN + path;
    const headers = { Referer: referer || ORIGIN + '/member_mypage.html' };
    try {
      const r = await PAGE.fetch(url, { method: 'GET', credentials: 'include', headers });
      return { status: r.status, text: await r.text(), url: r.url };
    } catch (e1) {
      return await pageFetch(url, { method: 'GET', headers });
    }
  }

  async function httpPost(path, body, referer) {
    const url = path.startsWith('http') ? path : ORIGIN + path;
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Origin: ORIGIN,
      Referer: referer || ORIGIN + '/member_regist.html?request=edit',
    };
    const bodyStr = new URLSearchParams(body).toString();
    try {
      const r = await PAGE.fetch(url, { method: 'POST', credentials: 'include', headers, body: bodyStr });
      return { status: r.status, text: await r.text(), url: r.url };
    } catch (e1) {
      return await pageFetch(url, { method: 'POST', headers, body: bodyStr });
    }
  }

  function escapeRe(name) {
    return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function parseInput(html, name) {
    const re = new RegExp('<input\\b[^>]*\\bname=["\']' + escapeRe(name) + '["\'][^>]*>', 'i');
    const m = html.match(re);
    if (!m) return '';
    const v = m[0].match(/\bvalue=["']([^"']*)["']/i);
    return v ? v[1].trim() : '';
  }

  function parseSelected(html, name) {
    const sm = html.match(new RegExp('<select[^>]*name=["\']' + escapeRe(name) + '["\'][^>]*>([\\s\\S]*?)</select>', 'i'));
    if (!sm) return '';
    const opt = sm[1].match(/<option[^>]*\bselected\b[^>]*>/i) || sm[1].match(/<option[^>]*selected=["']selected["'][^>]*>/i);
    if (!opt) return '';
    const v = opt[0].match(/\bvalue=["']([^"']*)["']/i);
    return v ? v[1].trim() : '';
  }

  function parseCheckedRadio(html, name) {
    const re = new RegExp('<input\\b[^>]*\\bname=["\']' + escapeRe(name) + '["\'][^>]*>', 'gi');
    let m;
    while ((m = re.exec(html))) {
      const tag = m[0];
      if (!/\bchecked\b/i.test(tag)) continue;
      const v = tag.match(/\bvalue=["']([^"']*)["']/i);
      return v ? v[1] : '';
    }
    return '';
  }

  function parseFormChunk(html, formName) {
    const head = html.match(new RegExp('<form[^>]*name=["\']' + escapeRe(formName) + '["\'][^>]*>', 'i'));
    const body = html.match(new RegExp('<form[^>]*name=["\']' + escapeRe(formName) + '["\'][^>]*>([\\s\\S]*?)</form>', 'i'));
    let action = '';
    if (head) {
      const am = head[0].match(/\baction=["']([^"']+)/i);
      if (am) action = am[1];
    }
    return { action, chunk: body ? body[1] : '' };
  }

  function parseHiddenFields(chunk) {
    const fields = {};
    const re = /<input\b[^>]*>/gi;
    let m;
    while ((m = re.exec(chunk))) {
      const tag = m[0];
      if (!/type=["']hidden["']/i.test(tag) && !/type=["']checkbox["']/i.test(tag) && !/type=["']radio["']/i.test(tag)) {
        const nm = tag.match(/\bname=["']([^"']+)["']/i);
        const vm = tag.match(/\bvalue=["']([^"']*)["']/i);
        if (nm && !/^jp\.co\.interfactory\.framework\./i.test(nm[1])) {
          fields[nm[1]] = vm ? vm[1] : '';
        }
        continue;
      }
      const nm = tag.match(/\bname=["']([^"']+)["']/i);
      if (!nm) continue;
      const name = nm[1];
      if (/^jp\.co\.interfactory\.framework\./i.test(name)) continue;
      if (/type=["']checkbox["']/i.test(tag)) {
        if (/\bchecked\b/i.test(tag)) {
          const vm = tag.match(/\bvalue=["']([^"']*)["']/i);
          fields[name] = vm ? vm[1] : '1';
        }
        continue;
      }
      if (/type=["']radio["']/i.test(tag)) {
        if (/\bchecked\b/i.test(tag)) {
          const vm = tag.match(/\bvalue=["']([^"']*)["']/i);
          fields[name] = vm ? vm[1] : '';
        }
        continue;
      }
      const vm = tag.match(/\bvalue=["']([^"']*)["']/i);
      fields[name] = vm ? vm[1] : '';
    }
    const selRe = /<select\b[^>]*name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/select>/gi;
    let sm;
    while ((sm = selRe.exec(chunk))) {
      const name = sm[1];
      const opt = sm[2].match(/<option[^>]*\bselected\b[^>]*>/i);
      if (!opt) continue;
      const v = opt[0].match(/\bvalue=["']([^"']*)["']/i);
      fields[name] = v ? v[1] : '';
    }
    return fields;
  }

  function extractParksError(html) {
    const text = html || '';
    const pats = [
      /form-error-message[\s\S]*?<li>([^<]+)/i,
      /<li[^>]*>([^<]{4,200})<\/li>/i,
      /class="error[^"]*"[^>]*>([^<]+)/i,
      /errorMessage[^>]*>([^<]+)/i,
    ];
    for (let i = 0; i < pats.length; i++) {
      const m = text.match(pats[i]);
      if (m && m[1] && m[1].trim()) return m[1].replace(/\s+/g, ' ').trim();
    }
    if (text.includes('セッションがタイムアウト') || text.includes('セキュリティのため')) {
      return '会话超时，请刷新页面重新登录后再提交';
    }
    return '';
  }

  function looksExecuteSuccess(resp) {
    const t = (resp && resp.text) || '';
    const u = (resp && resp.url) || '';
    if (t.includes('会員情報を更新しました')) return true;
    if (t.includes('form-message') && t.includes('更新しました')) return true;
    if (u.includes('member_regist_confirm') && t.includes('更新')) return true;
    return false;
  }

  function parseToken(html) {
    const m = (html || '').match(/name="token"\s+value="([0-9a-f]+)"/i);
    return m ? m[1] : '';
  }

  function parseMemberData(html) {
    const m = (html || '').match(/var\s+member_data\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) return {};
    try {
      return JSON.parse(m[1]);
    } catch (e) {
      return {};
    }
  }

  function parseProfile(html) {
    const md = parseMemberData(html);
    let tel = parseInput(html, 'TEL');
    if (!tel) {
      const tm = html.match(/(?<!\d)(070\d{8}|080\d{8}|090\d{8})(?!\d)/);
      if (tm) tel = tm[1];
    }
    const y = parseInput(html, 'BIRTH_YEAR');
    const mo = parseInput(html, 'BIRTH_MONTH');
    const d = parseInput(html, 'BIRTH_DAY');
    let birthday = (md.birth || '').replace(/\//g, '-');
    if (y && mo && d) {
      birthday = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
    const sex = parseCheckedRadio(html, 'SEX') || (md.sex || 'M').toString().charAt(0).toUpperCase();
    return {
      email: parseInput(html, 'PC_MAIL'),
      last_name: parseInput(html, 'L_NAME'),
      first_name: parseInput(html, 'F_NAME'),
      last_name_kana: parseInput(html, 'L_KANA') || parseInput(html, 'L_NAME_KANA'),
      first_name_kana: parseInput(html, 'F_KANA') || parseInput(html, 'F_NAME_KANA'),
      nickname: parseInput(html, 'NICKNAME'),
      addr1: parseSelected(html, 'ADDR1') || parseInput(html, 'ADDR1') || '東京都',
      zip: (parseInput(html, 'ZIP') || '').replace(/-/g, ''),
      addr2: parseInput(html, 'ADDR2'),
      addr_street: parseInput(html, 'MEMBER.FREE_ITEM16'),
      addr3: parseInput(html, 'ADDR3'),
      tel,
      gender: sex === 'F' || sex === '2' ? 'F' : (sex === 'M' || sex === '1' ? 'M' : 'M'),
      birthday: birthday || '1990-01-01',
      formFields: parseHiddenFields(parseFormChunk(html, 'memberFrm').chunk || html),
    };
  }

  function normalizeBirthday(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const m1 = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m1) {
      return `${m1[1]}-${String(parseInt(m1[2], 10)).padStart(2, '0')}-${String(parseInt(m1[3], 10)).padStart(2, '0')}`;
    }
    const digits = s.replace(/\D/g, '');
    if (digits.length === 8) {
      return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
    }
    return '';
  }

  function bdayParts(bday) {
    const norm = normalizeBirthday(bday) || '1990-01-01';
    const m = norm.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) return { y: '1990', mo: '1', d: '1' };
    return { y: m[1], mo: String(parseInt(m[2], 10)), d: String(parseInt(m[3], 10)) };
  }

  /** 提交时（登录态）读取资料 + token */
  async function loadProfileForSubmit() {
    reportLog('提交: 开始读取编辑页');
    const r = await httpGet('/member_regist.html?request=edit');
    const loggedIn = r.text.includes('ログアウト') || !!parseMemberData(r.text).member_id || !!parseInput(r.text, 'PC_MAIL');
    if (!loggedIn) {
      reportLog('提交: 未登录');
      throw new Error('未登录：请用 Safari 打开 parks2 完成登录（不要用无痕模式）');
    }
    const p = parseProfile(r.text);
    if (!p.tel) {
      reportLog('提交: 未解析到手机号');
      throw new Error('未读取到手机号，无法安全提交');
    }
    reportLog('提交: 编辑页读取成功 ' + p.last_name + ' ' + p.first_name);
    return p;
  }

  /** 提交到服务器：confirm（拿 token）→ execute */
  async function submitNameBirthday(profile, ln, fn, birthday, password) {
    const lk = profile.last_name_kana;
    const fk = profile.first_name_kana;
    const nick = profile.nickname || ln;
    const bday = normalizeBirthday(birthday) || profile.birthday || '1990-01-01';
    const { y, mo, d } = bdayParts(bday);
    const editRef = ORIGIN + '/member_regist.html?request=edit';
    const zip7 = String(profile.zip || '').replace(/-/g, '');
    const addr1 = profile.addr1 || '東京都';
    const addr2 = profile.addr2 || '';
    const addrStreet = profile.addr_street || '';
    const addr3 = profile.addr3 || '';
    const sex = profile.gender || 'M';
    if (!zip7 || !addr2 || !addrStreet) {
      throw new Error('当前资料缺邮编/市区町村/番地（官网已改为必填）。请先在「会員情報変更」填完整地址，再回来改名字。');
    }

    const confirm = Object.assign({}, profile.formFields || {}, {
      request: 'confirm',
      PC_MAIL_OLD: profile.email,
      FOREIGN_LOGIN_PROVIDER_KIND: '',
      MOBILE_MAIL_OLD: '',
      mode: '1',
      CART_MEMBER_REGIST: '',
      MAIL_FLG_OLD: '1',
      'SOCIAL_PLUS:SOCIAL_PLUS_ID': '',
      'SOCIAL_PLUS:PROVIDER': '',
      NICKNAME: nick,
      'jp.co.interfactory.framework.trim.NICKNAME': '',
      PC_MAIL: profile.email,
      'jp.co.interfactory.framework.trim.PC_MAIL': '',
      PASSWORD: password,
      PASSWORD2: password,
      SEX: sex,
      BIRTH_YEAR: y,
      'jp.co.interfactory.framework.trim.BIRTH_YEAR': '',
      BIRTH_MONTH: mo,
      'jp.co.interfactory.framework.trim.BIRTH_MONTH': '',
      BIRTH_DAY: d,
      'jp.co.interfactory.framework.trim.BIRTH_DAY': '',
      ZIP: zip7,
      'jp.co.interfactory.framework.trim.ZIP': '',
      ADDR1: addr1,
      ADDR2: addr2,
      'jp.co.interfactory.framework.trim.ADDR2': '',
      'MEMBER.FREE_ITEM16': addrStreet,
      'jp.co.interfactory.framework.trim.MEMBER.FREE_ITEM16': '',
      ADDR3: addr3,
      'jp.co.interfactory.framework.trim.ADDR3': '',
      TEL: profile.tel,
      'jp.co.interfactory.framework.trim.TEL': '',
      L_NAME: ln,
      F_NAME: fn,
      L_KANA: lk,
      'jp.co.interfactory.framework.trim.L_KANA': '',
      F_KANA: fk,
      'jp.co.interfactory.framework.trim.F_KANA': '',
      PC_MAIL_TYPE: '1',
      MOBILE_MAIL_TYPE: '1',
    });
    if (!addr3) confirm['MEMBER.FREE_ITEM19'] = '1';
    else delete confirm['MEMBER.FREE_ITEM19'];

    reportLog('提交: POST confirm');
    const r1 = await httpPost('/member_regist.html', confirm, editRef);
    if (r1.text.includes('sms_authentication') || r1.url.includes('sms_authentication')) {
      reportLog('提交: 触发 SMS 验证');
      throw new Error('触发了 SMS 验证（请勿改手机号）');
    }
    const confirmParsed = parseFormChunk(r1.text, 'confirmForm');
    const hidden = parseHiddenFields(confirmParsed.chunk);
    const token = hidden.token || parseToken(r1.text);
    if (!token) {
      const err = extractParksError(r1.text) || 'confirm 失败，请检查密码是否正确';
      reportLog('提交: confirm 未拿到 token → ' + err + ' | 响应片段: ' + String(r1.text || '').slice(0, 200));
      throw new Error(err);
    }
    reportLog('提交: token 已获取 (' + token.slice(0, 8) + '…)');

    const execute = Object.assign({}, hidden, {
      request: 'execute',
      token,
      MAIL_FLG: hidden.MAIL_FLG || '1',
      SEX: sex,
      BIRTH_YEAR: y,
      BIRTH_MONTH: mo,
      BIRTH_DAY: d,
      BIRTH: y + '/' + mo + '/' + d,
      ZIP: zip7 || hidden.ZIP || '',
      ADDR1: addr1 || hidden.ADDR1 || '',
      ADDR2: addr2 || hidden.ADDR2 || '',
      'MEMBER.FREE_ITEM16': addrStreet || hidden['MEMBER.FREE_ITEM16'] || '',
      ADDR3: addr3 || hidden.ADDR3 || '',
      TEL: profile.tel,
      L_NAME: ln,
      F_NAME: fn,
      L_KANA: lk,
      F_KANA: fk,
      NICKNAME: nick,
      PC_MAIL: profile.email,
      PASSWORD: password,
      PASSWORD2: password,
    });
    if (addr3) delete execute['MEMBER.FREE_ITEM19'];
    else execute['MEMBER.FREE_ITEM19'] = '1';

    const action = confirmParsed.action || '/member_regist_confirm.html';
    reportLog('提交: POST execute → ' + action);
    const r2 = await httpPost(action, execute, ORIGIN + '/member_regist.html');
    if (r2.text.includes('sms_authentication') || r2.url.includes('sms_authentication')) {
      reportLog('提交: execute 触发 SMS');
      throw new Error('execute 触发 SMS');
    }
    if (!looksExecuteSuccess(r2)) {
      const afterEdit = await httpGet('/member_regist.html?request=edit', ORIGIN + '/member_mypage.html');
      const after = parseProfile(afterEdit.text);
      if (after.last_name === ln && after.first_name === fn) {
        reportLog('提交: 成功（重读验证一致）');
        return { last_name: ln, first_name: fn, birthday: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
      }
      const err = extractParksError(r2.text) || 'execute 未返回成功页';
      reportLog('提交: execute 失败 → ' + err + ' | 响应片段: ' + String(r2.text || '').slice(0, 200));
      throw new Error(err);
    }
    reportLog('提交: 成功（响应含更新确认）');
    return { last_name: ln, first_name: fn, birthday: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` };
  }

  /* ---------- UI ---------- */

  const css = `
#${ICON_ID}{
  position:fixed;top:max(14px, env(safe-area-inset-top));right:14px;z-index:2147483646;
  width:46px;height:46px;border-radius:23px;border:none;cursor:pointer;
  background:linear-gradient(135deg,#e60012,#b8000f);color:#fff;
  font-size:16px;font-weight:700;box-shadow:0 4px 16px rgba(0,0,0,.35);
  display:flex;align-items:center;justify-content:center;
}
#${PANEL_ID}{
  position:fixed;left:0;right:0;bottom:0;z-index:2147483647;
  background:#fff;border-radius:16px 16px 0 0;padding:16px 16px calc(20px + env(safe-area-inset-bottom));
  box-sizing:border-box;max-height:85vh;overflow:auto;
  transform:translateY(110%);transition:transform .25s ease;
  font:14px/1.45 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB",sans-serif;
  color:#222;
}
#${PANEL_ID}.open{transform:translateY(0);}
#${PANEL_ID} *{box-sizing:border-box;}
.cpx-title{font-size:17px;font-weight:700;margin:0 0 4px;}
.cpx-sub{font-size:12px;color:#666;margin:0 0 10px;line-height:1.5;}
.cpx-row{margin-bottom:10px;}
.cpx-row label{display:block;font-size:12px;color:#444;margin-bottom:4px;}
.cpx-row input{width:100%;height:42px;border:1px solid #ddd;border-radius:8px;padding:0 12px;font-size:16px;}
.cpx-row input:focus{outline:none;border-color:#e60012;}
.cpx-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px;}
.cpx-btn{height:44px;border:none;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;}
.cpx-btn-primary{background:#e60012;color:#fff;}
.cpx-btn-secondary{background:#f3f4f6;color:#111;}
.cpx-log{margin-top:12px;font-size:12px;line-height:1.55;color:#333;background:#f9fafb;border-radius:8px;padding:10px;white-space:pre-wrap;max-height:150px;overflow:auto;}
.cpx-close{position:absolute;right:12px;top:12px;border:none;background:#eee;width:32px;height:32px;border-radius:16px;font-size:18px;cursor:pointer;}
.cpx-warn{font-size:11px;color:#b45309;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:8px 10px;margin-bottom:10px;line-height:1.45;}
`;

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildUI() {
    ensureStyles();

    const icon = document.createElement('button');
    icon.id = ICON_ID;
    icon.type = 'button';
    icon.textContent = '改';
    icon.title = '改会员资料（v0.10.1）';

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <button class="cpx-close" id="cpxClose" type="button">×</button>
      <p class="cpx-title">Bandai Parks 会员资料（v0.10.1）</p>
      <p class="cpx-sub">「读取姓名」直接解析当前页面 DOM（零请求）；「提交」时才联网走登录态拿 token。</p>
      <div class="cpx-warn">⚠ 读取不联网一定成功；提交会真实修改服务器资料（姓名+生日）。</div>
      <div class="cpx-row"><label>姓（L_NAME）</label><input id="cpxL" autocomplete="off" placeholder="姓" /></div>
      <div class="cpx-row"><label>名（F_NAME）</label><input id="cpxF" autocomplete="off" placeholder="名" /></div>
      <div class="cpx-row"><label>生日（BIRTH，YYYY-MM-DD，官网可能锁定）</label><input id="cpxB" type="date" placeholder="1999-07-12" /></div>
      <div class="cpx-row"><label>登录密码（只填密码，提交必填，不保存）</label><input id="cpxP" type="password" autocomplete="current-password" placeholder="只填登录密码" /></div>
      <div class="cpx-btns">
        <button class="cpx-btn cpx-btn-primary" id="cpxLoad" type="button">读取姓名（DOM）</button>
        <button class="cpx-btn cpx-btn-secondary" id="cpxClear" type="button">清空</button>
        <button class="cpx-btn cpx-btn-primary" id="cpxSubmit" type="button" style="grid-column:1/-1">提交到服务器（登录态拿 token）</button>
      </div>
      <div class="cpx-log" id="cpxLog">就绪：点「读取姓名」从当前页面 DOM 提取。</div>
    `;

    document.body.appendChild(icon);
    document.body.appendChild(panel);

    const logEl = panel.querySelector('#cpxLog');
    const setLog = (msg) => { logEl.textContent = msg; };
    const open = () => panel.classList.add('open');
    const close = () => panel.classList.remove('open');

    icon.addEventListener('click', () => {
      if (panel.classList.contains('open')) close();
      else open();
    });
    panel.querySelector('#cpxClose').addEventListener('click', close);

    // 读取：直接读当前页面 DOM（零请求）
    panel.querySelector('#cpxLoad').addEventListener('click', () => {
      reportLog('用户点击「读取姓名」');
      const n = readNameFromDom();
      if (!n) {
        setLog('❌ 当前页面没有姓名信息。\n请到以下页面再点：\n• 编辑页 member_regist.html?request=edit\n• 会员页 member_mypage.html');
        return;
      }
      panel.querySelector('#cpxL').value = n.last_name;
      panel.querySelector('#cpxF').value = n.first_name;
      setLog('✅ 已从页面 DOM 读取（来源：' + n.source + '）\n姓：' + n.last_name + '\n名：' + n.first_name);
    });

    panel.querySelector('#cpxClear').addEventListener('click', () => {
      panel.querySelector('#cpxL').value = '';
      panel.querySelector('#cpxF').value = '';
      panel.querySelector('#cpxB').value = '';
      setLog('已清空。');
    });

    // 提交：登录态 confirm → execute（拿 token）
    panel.querySelector('#cpxSubmit').addEventListener('click', async () => {
      const ln = panel.querySelector('#cpxL').value.trim();
      const fn = panel.querySelector('#cpxF').value.trim();
      const bRaw = panel.querySelector('#cpxB').value.trim();
      const pwd = panel.querySelector('#cpxP').value;
      if (!ln || !fn) { setLog('请先读取或填写姓和名'); return; }
      if (!pwd) { setLog('请填写登录密码'); return; }
      setLog('提交中…（confirm → execute，最多等 60 秒）');
      reportLog('用户点击「提交」姓=' + ln + ' 名=' + fn);
      try {
        const profile = await loadProfileForSubmit();
        const res = await submitNameBirthday(profile, ln, fn, bRaw, pwd);
        setLog('✅ 已提交到服务器并永久生效\n新氏名：' + res.last_name + ' ' + res.first_name + '\n生日：' + res.birthday);
      } catch (e) {
        setLog('❌ ' + e.message);
      }
    });
  }

  /* ---------- 启动 ---------- */

  function boot() {
    reportLog('BOOT UI v0.10.1');
    if (document.body) {
      buildUI();
      reportLog('UI 已注入');
      return;
    }
    const t = setInterval(() => {
      if (document.body) {
        clearInterval(t);
        buildUI();
        reportLog('UI 已注入');
      }
    }, 200);
  }

  boot();
})();
