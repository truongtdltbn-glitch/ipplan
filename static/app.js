/**
 * IP Plan Manager - Frontend
 * Inline table editing + auto-save on blur/debounce
 */

const API = '';
let vlans = [];
let currentVlanId = null;
let currentIps = [];
let currentIpAddr = null;
let currentFilter = 'all';
let saveTimers = {};

// ---- API ----
async function api(url, opts = {}) {
    const res = await fetch(API + url, {
        headers: { 'Content-Type': 'application/json', ...opts.headers },
        ...opts
    });
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Request failed');
    }
    return res.json();
}

// ---- Toast ----
function toast(msg, type = 'success') {
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = (type === 'success' ? '✓ ' : '✗ ') + msg;
    document.getElementById('toasts').appendChild(el);
    setTimeout(() => {
        el.style.transition = 'all .4s ease';
        el.style.opacity = '0';
        el.style.transform = 'translateX(32px)';
        setTimeout(() => el.remove(), 400);
    }, 2500);
}

// ---- Theme ----
(function initTheme() {
    const saved = localStorage.getItem('ipplan-theme');
    const toggle = document.getElementById('theme-toggle');
    if (saved === 'light') {
        document.documentElement.setAttribute('data-theme', 'light');
        toggle.textContent = '☀️';
    }
    toggle.addEventListener('click', () => {
        const isLight = document.documentElement.getAttribute('data-theme') === 'light';
        document.documentElement.setAttribute('data-theme', isLight ? '' : 'light');
        toggle.textContent = isLight ? '🌙' : '☀️';
        localStorage.setItem('ipplan-theme', isLight ? 'dark' : 'light');
    });
})();

// ---- User Menu ----
(function initUserMenu() {
    const btn = document.getElementById('user-btn');
    const dd = document.getElementById('user-dropdown');
    btn.addEventListener('click', (e) => { e.stopPropagation(); dd.classList.toggle('open'); });
    document.addEventListener('click', () => dd.classList.remove('open'));
    dd.addEventListener('click', (e) => e.stopPropagation());
})();

document.getElementById('btn-logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
});

// ---- Change Password ----
document.getElementById('btn-change-pw').addEventListener('click', () => {
    document.getElementById('user-dropdown').classList.remove('open');
    openModal('m-pw');
});
['mx-pw', 'mc-pw'].forEach(id => document.getElementById(id).addEventListener('click', () => closeModal('m-pw')));
document.getElementById('mk-pw').addEventListener('click', async () => {
    const cur = document.getElementById('pw-cur').value;
    const np = document.getElementById('pw-new').value;
    const confirm = document.getElementById('pw-confirm').value;
    if (!cur || !np) { toast('Vui lòng nhập đủ thông tin', 'error'); return; }
    if (np !== confirm) { toast('Mật khẩu xác nhận không khớp', 'error'); return; }
    if (np.length < 6) { toast('Mật khẩu mới phải ≥ 6 ký tự', 'error'); return; }
    try {
        await api('/api/change-password', { method: 'POST', body: JSON.stringify({ current_password: cur, new_password: np }) });
        closeModal('m-pw');
        ['pw-cur', 'pw-new', 'pw-confirm'].forEach(id => document.getElementById(id).value = '');
        toast('Đổi mật khẩu thành công!');
    } catch (e) { toast(e.message, 'error'); }
});

// ---- Load VLANs ----
async function loadVlans() {
    try {
        vlans = await api('/api/vlans');
        renderVlans();
        updateStats();
        // Auto select first VLAN if none selected
        if (vlans.length > 0 && !currentVlanId) {
            selectVlan(vlans[0].id);
        }
    } catch (e) { /* auth redirect */ }
}

function renderVlans() {
    const list = document.getElementById('vlan-list');
    const search = document.getElementById('vlan-search').value.toLowerCase();
    
    let filtered = vlans;
    if (search) {
        filtered = vlans.filter(v => 
            v.name.toLowerCase().includes(search) || 
            (v.vlan_id||'').toString().includes(search) ||
            v.subnet.includes(search)
        );
    }

    if (!filtered.length) {
        list.innerHTML = `<div class="empty"><div class="empty-icon">🔌</div><p>${vlans.length ? 'Không tìm thấy' : 'Chưa có VLAN'}</p><span>${vlans.length ? 'Thử từ khóa khác' : 'Nhấn "Thêm VLAN"'}</span></div>`;
        return;
    }
    list.innerHTML = filtered.map((v, i) => {
        const pct = v.total_ips ? Math.round(v.used_ips / v.total_ips * 100) : 0;
        const color = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--orange)' : 'var(--green)';
        return `<div class="vlan-card${v.id === currentVlanId ? ' active' : ''}" data-id="${v.id}" style="animation-delay:${i*50}ms">
            <button class="vc-del" data-del="${v.id}" data-name="${esc(v.name)}" title="Xoá">✕</button>
            <div class="vc-top"><span class="vc-name">${esc(v.name)}</span><span class="vc-id">ID ${v.vlan_id||'-'}</span></div>
            <div class="vc-subnet">${esc(v.subnet)}/${v.prefix}</div>
            <div class="vc-bar"><div class="vc-bar-fill" style="width:${pct}%;background:${color}"></div></div>
            <div class="vc-stats"><span class="vc-stat">Tổng: <b>${v.total_ips}</b></span><span class="vc-stat">Dùng: <b>${v.used_ips}</b></span><span class="vc-stat">Trống: <b>${v.free_ips}</b></span></div>
        </div>`;
    }).join('');

    list.querySelectorAll('.vlan-card').forEach(card => {
        card.addEventListener('click', (e) => { if (!e.target.closest('.vc-del')) selectVlan(card.dataset.id); });
    });
    list.querySelectorAll('.vc-del').forEach(btn => {
        btn.addEventListener('click', (e) => { e.stopPropagation(); openDeleteModal(btn.dataset.del, btn.dataset.name); });
    });
}

async function selectVlan(id) {
    currentVlanId = id;
    currentIpAddr = null;
    hideDetail();
    renderVlans();
    const v = vlans.find(x => x.id === id);
    document.getElementById('ip-title').textContent = `🌐 ${v ? v.name : 'IP'}`;
    try {
        currentIps = await api(`/api/vlans/${id}/ips`);
        renderIpTable();
        // Auto select first IP detail
        if (currentIps.length > 0) {
            selectIpDetail(currentIps[0].address);
        }
    } catch (e) { toast('Lỗi tải IPs: ' + e.message, 'error'); }
}

// ---- Render IP Table (inline edit) ----
function renderIpTable() {
    const list = document.getElementById('ip-list');
    const search = document.getElementById('ip-search').value.toLowerCase();
    let ips = currentIps;
    if (currentFilter === 'used') ips = ips.filter(ip => ip.used);
    else if (currentFilter === 'free') ips = ips.filter(ip => !ip.used);
    if (search) ips = ips.filter(ip =>
        ip.address.includes(search) ||
        (ip.hostname||'').toLowerCase().includes(search) ||
        (ip.system||'').toLowerCase().includes(search) ||
        (ip.owner||'').toLowerCase().includes(search)
    );

    if (!ips.length) {
        list.innerHTML = '<div class="empty"><div class="empty-icon">🌐</div><p>Không có IP</p><span>Thử bộ lọc khác</span></div>';
        return;
    }

    let html = `<table class="ip-table">
        <colgroup>
            <col style="width:36px">
            <col style="width:120px">
            <col>
            <col>
            <col>
        </colgroup>
        <thead><tr>
            <th class="td-status">⬤</th>
            <th>IP Address</th>
            <th>Hostname</th>
            <th>Hệ thống</th>
            <th>Người quản lý</th>
        </tr></thead><tbody>`;

    ips.forEach((ip, i) => {
        html += `<tr data-ip="${ip.address}" class="${ip.address === currentIpAddr ? 'active' : ''}" style="animation:rowFadeIn .3s var(--ease) ${Math.min(i*15,300)}ms backwards">
            <td class="td-status"><span class="td-dot ${ip.used?'used':'free'}" data-ip="${ip.address}" title="Nhấn để đổi trạng thái"></span></td>
            <td class="td-ip">${ip.address}</td>
            <td class="td-hostname">${esc(ip.hostname||'')}</td>
            <td class="td-system">${esc(ip.system||'')}</td>
            <td class="td-owner">${esc(ip.owner||'')}</td>
        </tr>`;
    });
    html += '</tbody></table>';
    list.innerHTML = html;

    // Row click → show detail
    list.querySelectorAll('tr[data-ip]').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.classList.contains('td-dot')) return;
            selectIpDetail(row.dataset.ip);
        });
    });

    // Status dot toggle
    list.querySelectorAll('.td-dot').forEach(dot => {
        dot.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleIpStatus(dot.dataset.ip);
        });
    });
}

async function saveIpDetail() {
    if (!currentVlanId || !currentIpAddr) return;
    const ip = currentIps.find(x => x.address === currentIpAddr);
    if (!ip) return;

    const updates = {
        hostname: document.getElementById('d-hostname').value.trim(),
        system: document.getElementById('d-system').value.trim(),
        owner: document.getElementById('d-owner').value.trim(),
        description: document.getElementById('d-desc').value.trim(),
    };

    // Check if anything actually changed
    if (updates.hostname === (ip.hostname || '') &&
        updates.system === (ip.system || '') &&
        updates.owner === (ip.owner || '') &&
        updates.description === (ip.description || '')) {
        return;
    }

    // Auto mark as used if fields are filled
    const shouldBeUsed = !!(updates.hostname || updates.system || updates.owner);
    const usedStatus = shouldBeUsed || ip.used; // Don't auto-unmark if it was already used? User preference usually is auto-mark.

    const statusEl = document.getElementById('save-status');
    statusEl.textContent = 'Đang lưu...';
    statusEl.classList.add('saving');

    try {
        const body = {
            used: usedStatus,
            ...updates
        };
        const updated = await api(`/api/vlans/${currentVlanId}/ips/${currentIpAddr}`, {
            method: 'PUT', body: JSON.stringify(body)
        });
        
        // Update local data
        const idx = currentIps.findIndex(x => x.address === currentIpAddr);
        if (idx >= 0) currentIps[idx] = updated;

        // Update table row if visible
        const row = document.querySelector(`tr[data-ip="${currentIpAddr}"]`);
        if (row) {
            row.querySelector('.td-hostname').textContent = updated.hostname || '';
            row.querySelector('.td-system').textContent = updated.system || '';
            row.querySelector('.td-owner').textContent = updated.owner || '';
            const dot = row.querySelector('.td-dot');
            if (dot) dot.className = `td-dot ${updated.used ? 'used' : 'free'}`;
        }
        
        // Update detail status icon
        document.getElementById('d-dot').className = 'ip-dot ' + (updated.used ? 'used' : 'free');
        document.getElementById('d-time').textContent = updated.updated_at ? new Date(updated.updated_at).toLocaleString('vi-VN') : '-';

        statusEl.textContent = 'Đã lưu';
        statusEl.classList.remove('saving');
        
        // Refresh VLAN stats in background
        loadVlans();
    } catch (e) {
        statusEl.textContent = 'Lỗi lưu';
        statusEl.classList.remove('saving');
        toast('Lỗi lưu: ' + e.message, 'error');
    }
}

// ---- Toggle IP Status ----
async function toggleIpStatus(ipAddr) {
    if (!currentVlanId) return;
    const ip = currentIps.find(x => x.address === ipAddr);
    if (!ip) return;
    try {
        const body = {
            used: !ip.used,
            hostname: ip.hostname || '',
            system: ip.system || '',
            owner: ip.owner || '',
            description: ip.description || '',
        };
        const updated = await api(`/api/vlans/${currentVlanId}/ips/${ipAddr}`, {
            method: 'PUT', body: JSON.stringify(body)
        });
        const idx = currentIps.findIndex(x => x.address === ipAddr);
        if (idx >= 0) currentIps[idx] = updated;
        // Update dot
        const dot = document.querySelector(`.td-dot[data-ip="${ipAddr}"]`);
        if (dot) dot.className = `td-dot ${updated.used ? 'used' : 'free'}`;
        if (currentIpAddr === ipAddr) showDetail(updated);
        loadVlans();
        toast(updated.used ? 'Đánh dấu đã sử dụng' : 'Đánh dấu trống');
    } catch (e) { toast('Lỗi: ' + e.message, 'error'); }
}

// ---- Detail Panel (Col 3) ----
function selectIpDetail(addr) {
    currentIpAddr = addr;
    const ip = currentIps.find(x => x.address === addr);
    if (!ip) return;
    // Highlight row
    document.querySelectorAll('tr[data-ip]').forEach(r => r.classList.toggle('active', r.dataset.ip === addr));
    showDetail(ip);
}

function showDetail(ip) {
    const de = document.getElementById('detail-empty');
    if (de) de.style.display = 'none';
    const form = document.getElementById('dform');
    form.style.display = '';

    document.getElementById('d-ip').textContent = ip.address;
    document.getElementById('d-dot').className = 'ip-dot ' + (ip.used ? 'used' : 'free');
    document.getElementById('detail-title').textContent = `📋 ${ip.address}`;
    document.getElementById('d-time').textContent = ip.updated_at ? new Date(ip.updated_at).toLocaleString('vi-VN') : '-';
    
    document.getElementById('d-hostname').value = ip.hostname || '';
    document.getElementById('d-system').value = ip.system || '';
    document.getElementById('d-owner').value = ip.owner || '';
    document.getElementById('d-desc').value = ip.description || '';
    
    document.getElementById('save-status').textContent = 'Đã lưu';
}

function hideDetail() {
    document.getElementById('dform').style.display = 'none';
    const de = document.getElementById('detail-empty');
    if (de) de.style.display = '';
}

// ---- Auto-save on Detail Panel ----
let detailSaveTimer = null;
function debouncedDetailSave() {
    if (detailSaveTimer) clearTimeout(detailSaveTimer);
    document.getElementById('save-status').textContent = 'Đang chờ...';
    detailSaveTimer = setTimeout(saveIpDetail, 1000);
}

['d-hostname', 'd-system', 'd-owner', 'd-desc'].forEach(id => {
    document.getElementById(id).addEventListener('input', debouncedDetailSave);
});

// Dot click in detail also toggles status
document.getElementById('d-dot').addEventListener('click', () => {
    if (currentIpAddr) toggleIpStatus(currentIpAddr);
});

// ---- Filter tabs ----
document.querySelectorAll('.ftab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.ftab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.f;
        renderIpTable();
    });
});

document.getElementById('ip-search').addEventListener('input', () => renderIpTable());
document.getElementById('vlan-search').addEventListener('input', () => renderVlans());

// ---- Modal helpers ----
function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

// ---- Add VLAN ----
document.getElementById('btn-add-vlan').addEventListener('click', () => openModal('m-vlan'));
['mx-vlan', 'mc-vlan'].forEach(id => document.getElementById(id).addEventListener('click', () => closeModal('m-vlan')));
document.getElementById('mk-vlan').addEventListener('click', async () => {
    const body = {
        name: document.getElementById('v-name').value.trim(),
        vlan_id: document.getElementById('v-id').value || null,
        subnet: document.getElementById('v-sub').value.trim(),
        prefix: document.getElementById('v-mask').value,
        description: document.getElementById('v-desc').value.trim(),
    };
    if (!body.name || !body.subnet) { toast('Vui lòng nhập tên và subnet', 'error'); return; }
    try {
        const res = await api('/api/vlans', { method: 'POST', body: JSON.stringify(body) });
        closeModal('m-vlan');
        ['v-name', 'v-id', 'v-sub', 'v-desc'].forEach(id => document.getElementById(id).value = '');
        toast(`Đã tạo VLAN với ${res.total_ips} IPs`);
        loadVlans();
    } catch (e) { toast('Lỗi: ' + e.message, 'error'); }
});

// ---- Delete VLAN ----
let deleteVlanId = null;
function openDeleteModal(id, name) {
    deleteVlanId = id;
    document.getElementById('del-name').textContent = name;
    openModal('m-del');
}
['mx-del', 'mc-del'].forEach(id => document.getElementById(id).addEventListener('click', () => closeModal('m-del')));
document.getElementById('mk-del').addEventListener('click', async () => {
    if (!deleteVlanId) return;
    try {
        await api(`/api/vlans/${deleteVlanId}`, { method: 'DELETE' });
        closeModal('m-del');
        if (currentVlanId === deleteVlanId) {
            currentVlanId = null; currentIps = []; currentIpAddr = null;
            document.getElementById('ip-list').innerHTML = '<div class="empty"><div class="empty-icon">🌐</div><p>Chọn VLAN</p><span>Chọn VLAN bên trái</span></div>';
            hideDetail();
        }
        toast('Đã xoá VLAN');
        loadVlans();
    } catch (e) { toast('Lỗi: ' + e.message, 'error'); }
});

// ---- Export/Import ----
document.getElementById('btn-export').addEventListener('click', () => { window.location.href = '/api/export'; });
document.getElementById('btn-import').addEventListener('click', () => { document.getElementById('file-import').click(); });
document.getElementById('file-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
        const res = await fetch('/api/import', { method: 'POST', body: fd });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        toast(`Đã nhập ${data.vlans} VLANs`);
        currentVlanId = null; currentIps = []; currentIpAddr = null;
        loadVlans();
    } catch (e) { toast('Lỗi nhập: ' + e.message, 'error'); }
    e.target.value = '';
});

// ---- Stats ----
function updateStats() {
    document.getElementById('s-vlans').textContent = vlans.length;
    const total = vlans.reduce((s, v) => s + v.total_ips, 0);
    const used = vlans.reduce((s, v) => s + v.used_ips, 0);
    document.getElementById('s-total').textContent = total;
    document.getElementById('s-used').textContent = used;
    document.getElementById('s-free').textContent = total - used;
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Close modals on overlay click
document.querySelectorAll('.overlay').forEach(ov => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('open'); });
});

// ---- Init ----
['vlan-search', 'ip-search'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
});
loadVlans();
