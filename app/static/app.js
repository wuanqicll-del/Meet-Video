/**
 * yt-dlp 下载器 - 前端
 */

let tasks = {};
let parsedInfo = null;
let _lastTasksJson = '';
let _renderedTasks = {};
let _loadTasksTimer = null;
let _loadTasksAbort = null;
let _deletedIds = {};  // 乐观删除的 ID → 过期时间戳，防止 SSE task_update 把它加回来
let _lastProgress = {};  // 下载中任务最后收到进度的时间戳
let _progressTimer = null;  // 进度检查定时器 ID

// 关闭 overlay 带动画：inline visibility 保持可见，动画结束后清除
function _closeOverlay(overlayId) {
    var el = document.getElementById(overlayId);
    el.style.visibility = 'visible';
    var panel = el.querySelector('.settings-panel, .format-panel');
    if (panel) {
        panel.addEventListener('transitionend', function handler(e) {
            if (e.target !== panel) return;
            panel.removeEventListener('transitionend', handler);
            if (!el.classList.contains('show')) {
                el.style.visibility = '';
            }
        });
    }
    el.classList.remove('show');
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function esc(s) {
    if (!s) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtResolution(res) {
    if (!res) return '';
    var match = res.match(/(\d+)x(\d+)/);
    if (!match) return res;
    var dim = Math.max(parseInt(match[1]), parseInt(match[2]));
    if (dim >= 3840) return '4K';
    if (dim >= 2560) return '2K';
    if (dim >= 1920) return '1080P';
    if (dim >= 1280) return '720P';
    if (dim >= 854) return '480P';
    if (dim >= 640) return '360P';
    return dim + 'P';
}

function fmtSpeed(speed) {
    if (!speed) return '0 B/s';
    var match = speed.match(/([\d.]+)\s*([KMG]?i?B)/);
    if (!match) return speed;
    var val = parseFloat(match[1]);
    var unit = match[2];
    if (unit.startsWith('K')) val *= 1024;
    else if (unit.startsWith('M')) val *= 1024 * 1024;
    else if (unit.startsWith('G')) val *= 1024 * 1024 * 1024;
    if (val >= 1024 * 1024 * 1024) return (val / (1024 * 1024 * 1024)).toFixed(1) + ' GB/s';
    if (val >= 1024 * 1024) return (val / (1024 * 1024)).toFixed(1) + ' MB/s';
    if (val >= 1024) return (val / 1024).toFixed(1) + ' KB/s';
    return val.toFixed(0) + ' B/s';
}

function fmtDuration(str) {
    if (!str) return '';
    var parts = str.split(':');
    if (parts.length === 3) {
        var h = parseInt(parts[0]);
        var m = parseInt(parts[1]);
        if (h > 0 && m > 0) return h + '小时' + m + '分钟';
        if (h > 0) return h + '小时';
        if (m > 0) return m + '分钟';
        return '不到1分钟';
    }
    if (parts.length === 2) {
        var m = parseInt(parts[0]);
        if (m > 0) return m + '分钟';
        return '不到1分钟';
    }
    return str;
}

// ======================== 快速下载（不解析直接最佳画质） ========================

function doQuickDownload() {
    var raw = document.getElementById('url-input').value.trim();
    if (!raw) { toast('请输入链接', 'error'); return; }
    var urls = raw.split('\n').map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
    if (!urls.length) { toast('请输入链接', 'error'); return; }
    // 记住原始内容，清空输入框
    document.getElementById('url-input').value = '';
    autoResize(document.getElementById('url-input'));
    // 后台发请求
    var total = urls.length, success = 0, fail = 0;
    urls.forEach(function(url) {
        fetch('/api/download', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({url: url, title: '', format_spec: 'bestvideo*+bestaudio/best'})
        })
        .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
        .then(function(data) {
            if (data.status === 'ok') { success++; } else { fail++; toast(data.msg || '添加失败: ' + url, 'error'); }
        })
        .catch(function() { fail++; toast('请求失败: ' + url, 'error'); })
        .then(function() {
            // 全部请求完成后提示统计
            if (success + fail === total) {
                if (fail > 0) { toast(success + ' 个已添加，' + fail + ' 个失败', 'warning'); }
            }
        });
    });
}

// ======================== 解析 ========================

function doParse() {
    var raw = document.getElementById('url-input').value.trim();
    if (!raw) { toast('请输入链接', 'error'); return; }
    var urls = raw.split('\n').map(function(s){ return s.trim(); }).filter(function(s){ return s.length > 0; });
    if (urls.length > 1) { toast('多链接请直接点下载，解析仅支持单个链接', 'warning'); return; }
    var url = urls[0];
    var btn = document.getElementById('parse-btn');
    btn.disabled = true;
    btn.textContent = '解析中...';

    fetch('/api/parse', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url: url})
    })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
        btn.disabled = false;
        btn.textContent = '解析';
        if (data.status !== 'ok') { toast(data.msg || '解析失败', 'error'); return; }
        parsedInfo = data.data;
        showFormats(parsedInfo);
    })
    .catch(function(err) {
        btn.disabled = false;
        btn.textContent = '解析';
        toast('请求失败', 'error');
    });
}

function showFormats(info) {
    // 显示格式选择浮窗
    var el = document.getElementById('format-overlay');
    el.offsetHeight;
    requestAnimationFrame(function() {
        el.classList.add('show');
    });

    // 视频信息
    var html = '';
    if (info.thumbnail) html += '<img src="' + esc(info.thumbnail) + '">';
    html += '<div class="meta">';
    html += '<div class="title">' + esc(info.title) + '</div>';
    html += '<div class="details">';
    if (info.uploader) html += '<span>' + esc(info.uploader) + '</span>';
    if (info.duration_str) html += '<span>时长 ' + esc(info.duration_str) + '</span>';
    if (info.extractor) html += '<span>' + esc(info.extractor) + '</span>';
    html += '</div></div>';
    document.getElementById('video-info').innerHTML = html;

    // 填充表格
    fillTable('combined', info.combined_formats || []);
    fillTable('video', info.video_formats || []);
    fillTable('audio', info.audio_formats || []);

    // 重置
    // 互斥初始化：默认选视频流+音频流
    var vv = document.querySelector('input[name="fmt-video"]');
    var av = document.querySelector('input[name="fmt-audio"]');
    var cv = document.querySelector('input[name="fmt-combined"]');
    if (vv && av) {
        vv.checked = true;
        av.checked = true;
        if (cv) cv.checked = false;
        // 高亮第一行
        var vTbl = document.getElementById('tbl-video');
        var aTbl = document.getElementById('tbl-audio');
        if (vTbl && vTbl.querySelector('tbody tr')) vTbl.querySelector('tbody tr').classList.add('selected');
        if (aTbl && aTbl.querySelector('tbody tr')) aTbl.querySelector('tbody tr').classList.add('selected');
    } else if (cv) {
        var cTbl = document.getElementById('tbl-combined');
        if (cTbl && cTbl.querySelector('tbody tr')) cTbl.querySelector('tbody tr').classList.add('selected');
    }
}

function closeFormatPanel() {
    _closeOverlay('format-overlay');
}

function fillTable(type, fmts) {
    var sec = document.getElementById('sec-' + type);
    var tbl = document.getElementById('tbl-' + type);
    if (!fmts.length) { sec.style.display = 'none'; return; }
    sec.style.display = '';
    var tbody = tbl.querySelector('tbody');

    // 先拼好完整 HTML，一次赋值，避免 N 次 innerHTML 重排
    var rowsHtml = fmts.map(function(f, i) {
        var radio = '<input type="radio" name="fmt-' + type + '" value="' + esc(f.id) + '"' + (i === 0 ? ' checked' : '') + ' style="display:none">';
        var cells;
        if (type === 'audio') {
            var acodec = (f.acodec || '-').substring(0, 4).replace(/\.+$/, '') || '-';
            cells = radio +
                '<td class="codec-cell">' + esc(acodec) + '</td>' +
                '<td>' + fmtSize(f.filesize) + '</td>' +
                '<td>' + fmtBitrate(f.abr) + '</td>';
        } else {
            var vc = (f.vcodec || '-').substring(0, 4).replace(/\.+$/, '') || '-';
            var ac = (f.acodec || '-').substring(0, 4).replace(/\.+$/, '') || '-';
            var codec = type === 'combined'
                ? (esc(vc) + '/' + esc(ac))
                : esc(vc);
            var res = f.resolution || (f.width && f.height ? f.width + 'x' + f.height : '-');
            var fps = f.fps ? f.fps + 'fps' : '-';
            var bitrate = fmtBitrate(f.tbr);
            var hdr = f.hdr || '';
            cells = radio +
                '<td>' + (hdr ? '<span class="hdr-tag' + (hdr === 'SDR' ? ' sdr' : '') + '">' + esc(hdr) + '</span>' : '-') + '</td>' +
                '<td>' + res + '</td>' +
                '<td>' + fps + '</td>' +
                '<td class="codec-cell">' + codec + '</td>' +
                '<td>' + fmtSize(f.filesize) + '</td>' +
                '<td>' + bitrate + '</td>';
        }
        return '<tr>' + cells + '</tr>';
    }).join('');

    tbody.innerHTML = rowsHtml;

    // 事件委托：用单个处理器代替 N 个 click + N 个 change 监听
    tbody.onclick = function(e) {
        var tr = e.target.closest('tr');
        if (!tr || !tbody.contains(tr)) return;
        var radioEl = tr.querySelector('input[type="radio"]');
        if (!radioEl) return;
        radioEl.checked = true;
        // 高亮当前行，取消同组其他行高亮
        var rows = tbody.querySelectorAll('tr');
        for (var r = 0; r < rows.length; r++) rows[r].classList.remove('selected');
        tr.classList.add('selected');
        // 互斥逻辑
        if (type === 'combined') {
            var vv = document.querySelector('input[name="fmt-video"]:checked');
            var av = document.querySelector('input[name="fmt-audio"]:checked');
            if (vv) vv.checked = false;
            if (av) av.checked = false;
            var vTbl = document.getElementById('tbl-video');
            var aTbl = document.getElementById('tbl-audio');
            if (vTbl) { var vr = vTbl.querySelectorAll('tr'); for (var i = 0; i < vr.length; i++) vr[i].classList.remove('selected'); }
            if (aTbl) { var ar = aTbl.querySelectorAll('tr'); for (var j = 0; j < ar.length; j++) ar[j].classList.remove('selected'); }
        } else {
            var cv = document.querySelector('input[name="fmt-combined"]:checked');
            if (cv) cv.checked = false;
            var cTbl = document.getElementById('tbl-combined');
            if (cTbl) { var cr = cTbl.querySelectorAll('tr'); for (var k = 0; k < cr.length; k++) cr[k].classList.remove('selected'); }
        }
    };
}

function buildSpec() {
    var cv = document.querySelector('input[name="fmt-combined"]:checked');
    var vv = document.querySelector('input[name="fmt-video"]:checked');
    var av = document.querySelector('input[name="fmt-audio"]:checked');
    if (cv && !vv && !av) return cv.value;
    if (vv && av) return vv.value + '+' + av.value;
    if (vv) return vv.value + '+bestaudio';
    if (av) return av.value;
    if (cv) return cv.value;
    return 'bestvideo*+bestaudio/best';
}

function fmtSize(b) {
    if (!b) return '-';
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' MB';
    return (b / 1073741824).toFixed(2) + ' GB';
}

function fmtBitrate(kbps) {
    if (!kbps) return '-';
    if (kbps >= 1000) return (kbps / 1000).toFixed(1) + ' Mbps';
    return Math.round(kbps) + ' kbps';
}

// ======================== 下载 ========================

function doDownload() {
    if (!parsedInfo) { toast('请先解析链接', 'error'); return; }
    var url = document.getElementById('url-input').value.trim();
    var spec = buildSpec();

    // 从解析结果提取选中格式的信息
    var fmtInfo = {};
    var selectedSpec = spec;
    var allFormats = (parsedInfo.combined_formats || []).concat(parsedInfo.video_formats || []).concat(parsedInfo.audio_formats || []);
    // 根据 buildSpec 返回的格式 ID 找到对应格式
    var specIds = selectedSpec.split('+');
    var selectedFmt = null;
    for (var i = 0; i < allFormats.length; i++) {
        if (specIds.indexOf(allFormats[i].id) !== -1 && allFormats[i].vcodec && allFormats[i].vcodec !== 'none') {
            selectedFmt = allFormats[i];
            break;
        }
    }
    // 没找到则 fallback 到最佳视频流
    if (!selectedFmt) {
        for (var i = 0; i < allFormats.length; i++) {
            if (allFormats[i].vcodec && allFormats[i].vcodec !== 'none') {
                selectedFmt = allFormats[i];
                break;
            }
        }
    }
    if (selectedFmt) {
        fmtInfo.resolution = selectedFmt.resolution || (selectedFmt.width && selectedFmt.height ? selectedFmt.width + 'x' + selectedFmt.height : '');
        fmtInfo.fps = selectedFmt.fps || '';
        fmtInfo.vcodec = selectedFmt.vcodec || '';
        fmtInfo.tbr = selectedFmt.tbr || '';
        fmtInfo.hdr = selectedFmt.hdr || '';
        if (selectedFmt.filesize) fmtInfo.filesize = selectedFmt.filesize;
    }
    if (parsedInfo.duration) fmtInfo.duration = parsedInfo.duration;
    if (parsedInfo.duration_str) fmtInfo.duration_str = parsedInfo.duration_str;

    fetch('/api/download', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({url: url, title: parsedInfo.title, format_spec: spec, format_info: fmtInfo})
    })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
        if (data.status === 'ok') {
            toast('任务已添加', 'success');
            closeFormatPanel();
            document.getElementById('url-input').value = '';
            parsedInfo = null;
        } else {
            toast(data.msg || '添加失败', 'error');
        }
    })
    .catch(function() { toast('请求失败', 'error'); });
}

// ======================== 任务渲染 ========================

var STATUS_TEXT = {
    queued: '排队中', downloading: '下载中', merging: '合并中',
    finished: '已完成', failed: '失败', stopped: '已暂停'
};

function loadTasks(immediate) {
    clearTimeout(_loadTasksTimer);
    if (immediate) {
        _doLoadTasks();
    } else {
        _loadTasksTimer = setTimeout(_doLoadTasks, 200);
    }
}

function _doLoadTasks() {
    if (_loadTasksAbort) _loadTasksAbort.abort();
    _loadTasksAbort = new AbortController();
    
    fetch('/api/tasks?t=' + Date.now(), { signal: _loadTasksAbort.signal })
    .then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
    })
    .then(function(data) {
        if (data.status === 'ok') {
            var json = JSON.stringify(data.data);
            if (json !== _lastTasksJson) {
                _lastTasksJson = json;
                tasks = data.data;
                renderTasks();
                updateHeaderStats();
            }
        }
    })
    .catch(function(err) {
        if (err.name === 'AbortError') return;
        console.error('loadTasks 失败:', err);
        // 静默重试一次
        setTimeout(_doLoadTasks, 1000);
    });
}

function updateHeaderStats() {
    var allTasks = Object.values(tasks);
    var downloading = allTasks.filter(function(t) { return t.status === 'downloading' || t.status === 'merging'; });
    var total = allTasks.length;
    var done = allTasks.filter(function(t) { return t.status === 'finished'; }).length;
    
    // 计算总进度（仅统计未完成任务，避免已完成任务拉高平均值）
    var activeTasks = allTasks.filter(function(t) { return t.status !== 'finished' && t.status !== 'failed'; });
    var totalProgress = 0;
    if (activeTasks.length > 0) {
        activeTasks.forEach(function(t) {
            totalProgress += (t.progress || 0);
        });
        totalProgress = totalProgress / activeTasks.length;
    } else if (total > 0) {
        totalProgress = 100;
    }
    
    // 更新总任务数
    var statCount = document.getElementById('stat-count');
    if (statCount) {
        statCount.textContent = total + '个';
    }
    
    // 更新已完成数
    var statDone = document.getElementById('stat-done');
    if (statDone) {
        statDone.textContent = done + '个';
    }
    
    // 更新总进度
    var statProgress = document.getElementById('stat-progress');
    if (statProgress) {
        statProgress.textContent = totalProgress.toFixed(0) + '%';
    }
    
    // 计算总下载速度
    var totalSpeed = 0;
    downloading.forEach(function(t) {
        if (t.speed) {
            var match = t.speed.match(/([\d.]+)\s*([KMG]?i?B)/);
            if (match) {
                var val = parseFloat(match[1]);
                var unit = match[2];
                if (unit.startsWith('K')) val *= 1024;
                else if (unit.startsWith('M')) val *= 1024 * 1024;
                else if (unit.startsWith('G')) val *= 1024 * 1024 * 1024;
                totalSpeed += val;
            }
        }
    });
    
    // 格式化总速度
    var statSpeed = document.getElementById('stat-speed');
    if (statSpeed) {
        if (totalSpeed >= 1024 * 1024 * 1024) {
            statSpeed.textContent = (totalSpeed / (1024 * 1024 * 1024)).toFixed(1) + ' GB/s';
        } else if (totalSpeed >= 1024 * 1024) {
            statSpeed.textContent = (totalSpeed / (1024 * 1024)).toFixed(1) + ' MB/s';
        } else if (totalSpeed >= 1024) {
            statSpeed.textContent = (totalSpeed / 1024).toFixed(1) + ' KB/s';
        } else {
            statSpeed.textContent = totalSpeed.toFixed(0) + ' B/s';
        }
    }
}

function renderTasks() {
    var container = document.getElementById('tasks');
    var list = Object.values(tasks).sort(function(a, b) {
        return (a.created_at || 0) - (b.created_at || 0);
    });

    if (!list.length) {
        container.innerHTML = '';
        _renderedTasks = {};
        return;
    }

    // 收集当前任务 ID
    var currentIds = {};
    list.forEach(function(t) { currentIds[t.id] = true; });

    // 删除已不存在的任务卡片
    var existingCards = container.querySelectorAll('.task-card');
    existingCards.forEach(function(card) {
        var id = card.getAttribute('data-id');
        if (!currentIds[id]) {
            card.remove();
            delete _renderedTasks[id];
        }
    });

    // 更新或添加任务
    list.forEach(function(t, index) {
        var existing = container.querySelector('[data-id="' + t.id + '"]');
        if (existing) {
            // 更新现有卡片内容（不重建 DOM）
            updateCard(existing, t);
        } else {
            // 新任务，创建卡片并添加动画
            var card = createCard(t);
            card.classList.add('new-card');
            // 插入到正确位置
            if (index === 0) {
                container.insertBefore(card, container.firstChild);
            } else {
                var prev = container.children[index - 1];
                if (prev && prev.nextSibling) {
                    container.insertBefore(card, prev.nextSibling);
                } else {
                    container.appendChild(card);
                }
            }
            _renderedTasks[t.id] = true;
        }
    });
}

function createCard(t) {
    var card = document.createElement('div');
    card.className = 'task-card';
    card.setAttribute('data-id', t.id);
    buildCardHTML(card, t);
    return card;
}

function updateCard(card, t) {
    // 只更新变化的内容，不重建整个卡片
    var prog = t.status === 'merging' ? 99 : (t.progress || 0);
    
    // 更新标题（解决"获取中"不更新的问题）
    var titleEl = card.querySelector('.task-title');
    if (titleEl && t.title && titleEl.textContent !== t.title) {
        titleEl.textContent = t.title;
        titleEl.setAttribute('title', t.title);
    }
    
    // 更新状态标签
    var statusEl = card.querySelector('.task-status');
    if (statusEl) {
        var newClass = 'task-status ' + t.status;
        if (statusEl.className !== newClass) {
            statusEl.className = newClass;
            statusEl.textContent = STATUS_TEXT[t.status] || t.status;
        }
        if (t.status === 'failed' && t.error) {
            statusEl.setAttribute('data-error', t.error);
        } else {
            statusEl.removeAttribute('data-error');
        }
    }
    
    // 更新进度条
    var progressFill = card.querySelector('.progress-fill');
    if (progressFill) {
        progressFill.style.width = prog + '%';
        var newFillClass = 'progress-fill';
        if (t.status === 'finished') newFillClass += ' done';
        else if (t.status === 'failed') newFillClass += ' error';
        if (progressFill.className !== newFillClass) {
            progressFill.className = newFillClass;
        }
    }
    
    // 更新格式标签
    var fmtEl = card.querySelector('.task-fmt');
    if (fmtEl) {
        var fmtContent = '';
        if (t.format_info && t.format_info.resolution) {
            var parts = [];
            if (t.format_info.duration_str) parts.push('<span class="fmt-tag">' + fmtDuration(t.format_info.duration_str) + '</span>');
            if (t.format_info.resolution) parts.push('<span class="fmt-tag">' + fmtResolution(t.format_info.resolution) + '</span>');
            if (t.format_info.hdr) parts.push('<span class="fmt-tag">' + esc(t.format_info.hdr) + '</span>');
            if (t.format_info.fps) parts.push('<span class="fmt-tag">' + t.format_info.fps + 'FPS</span>');
            if (t.format_info.vcodec) parts.push('<span class="fmt-tag">' + esc(t.format_info.vcodec.substring(0, 4).replace(/\.+$/, '').toUpperCase()) + '</span>');
            if (t.format_info.tbr) parts.push('<span class="fmt-tag">' + fmtBitrate(t.format_info.tbr) + '</span>');
            fmtContent = parts.join('');
        } else if (t.format_spec && t.format_spec !== 'bestvideo*+bestaudio/best') {
            fmtContent = '<span class="fmt-tag">' + esc(t.format_spec) + '</span>';
        } else {
            fmtContent = '<span class="fmt-tag">最佳画质</span>';
        }
        fmtEl.innerHTML = fmtContent;
    }
    // 更新右上角文件大小标签
    var hdrRight = card.querySelector('.task-header-right');
    if (hdrRight) {
        var fsTag = hdrRight.querySelector('.fmt-tag');
        var fsVal = t.format_info && t.format_info.filesize ? fmtSize(t.format_info.filesize) : '';
        if (fsVal) {
            if (fsTag) { fsTag.textContent = fsVal; }
            else { hdrRight.insertAdjacentHTML('afterbegin', '<span class="fmt-tag">' + fsVal + '</span>'); }
        } else if (fsTag) { fsTag.remove(); }
    }
    
    // 更新速度
    var speedEl = card.querySelector('.task-speed');
    if (speedEl) {
        speedEl.textContent = fmtSpeed(t.speed) || '';
    }
    
    // 更新任务信息（进度、速度、剩余时间）
    var infoEl = card.querySelector('.task-info');
    if (infoEl) {
        var prog = t.progress || 0;
        var speed = fmtSpeed(t.speed);
        var eta = t.eta || '--';
        infoEl.innerHTML = '<span class="task-info-item prog-item"><span class="task-info-label">进度</span><span class="task-info-value">' + prog.toFixed(1) + '%</span></span>' +
            '<span class="task-info-item speed-item"><span class="task-info-label">速度</span><span class="task-info-value">' + esc(speed) + '</span></span>' +
            '<span class="task-info-item eta-item"><span class="task-info-label">剩余</span><span class="task-info-value">' + esc(eta) + '</span></span>';
    }
    
    // 更新操作按钮
    var actionsEl = card.querySelector('.task-actions');
    if (actionsEl) {
        actionsEl.innerHTML = buildActionsHTML(t);
    }
}

function buildActionsHTML(t) {
    var s = t.status;
    var id = t.id;
    
    // 暂停/继续按钮
    var pauseResume = '';
    if (s === 'downloading' || s === 'merging') {
        pauseResume = '<button class="warning" onclick="pauseTask(\'' + id + '\')">暂停</button>';
    } else if (s === 'stopped') {
        pauseResume = '<button class="primary" onclick="resumeTask(\'' + id + '\')">继续</button>';
    } else if (s === 'failed') {
        pauseResume = '<button class="primary" disabled>继续</button>';
    } else {
        pauseResume = '<button class="warning" disabled>暂停</button>';
    }
    
    // 重试按钮
    var retry = '';
    if (s === 'stopped' || s === 'failed' || s === 'finished') {
        retry = '<button class="purple" onclick="retryTask(\'' + id + '\')">重试</button>';
    } else {
        retry = '<button class="purple" disabled>重试</button>';
    }
    
    // 删除按钮
    var del = '<button class="danger" onclick="deleteTask(\'' + id + '\')">删除</button>';
    
    return pauseResume + retry + del;
}

function buildCardHTML(card, t) {
    // 格式标签
    var fmtHtml = '';
    var filesizeHtml = '';
    if (t.format_info && t.format_info.resolution) {
        var parts = [];
        if (t.format_info.duration_str) parts.push('<span class="fmt-tag">' + fmtDuration(t.format_info.duration_str) + '</span>');
        if (t.format_info.resolution) parts.push('<span class="fmt-tag">' + fmtResolution(t.format_info.resolution) + '</span>');
        if (t.format_info.hdr) parts.push('<span class="fmt-tag">' + esc(t.format_info.hdr) + '</span>');
        if (t.format_info.fps) parts.push('<span class="fmt-tag">' + t.format_info.fps + 'FPS</span>');
        if (t.format_info.vcodec) parts.push('<span class="fmt-tag">' + esc(t.format_info.vcodec.substring(0, 4).replace(/\.+$/, '').toUpperCase()) + '</span>');
        if (t.format_info.tbr) parts.push('<span class="fmt-tag">' + fmtBitrate(t.format_info.tbr) + '</span>');
        if (t.format_info.filesize) filesizeHtml = '<span class="fmt-tag">' + fmtSize(t.format_info.filesize) + '</span>';
        fmtHtml = '<div class="task-fmt">' + parts.join('') + '</div>';
    } else if (t.format_spec && t.format_spec !== 'bestvideo*+bestaudio/best') {
        fmtHtml = '<div class="task-fmt"><span class="fmt-tag">' + esc(t.format_spec) + '</span></div>';
    } else {
        fmtHtml = '<div class="task-fmt"><span class="fmt-tag">最佳画质</span></div>';
    }

    // 进度条样式
    var fillClass = 'progress-fill';
    if (t.status === 'finished') fillClass += ' done';
    else if (t.status === 'failed') fillClass += ' error';
    var prog = t.status === 'merging' ? 99 : (t.progress || 0);

    // 失败状态标签带上错误信息
    var statusExtra = '';
    if (t.status === 'failed' && t.error) {
        statusExtra = ' data-error="' + esc(t.error) + '"';
    }

    // 底部行：详细信息 + 按钮
    var prog = t.progress || 0;
    var speed = fmtSpeed(t.speed);
    var eta = t.eta || '--';
    
    var infoHtml = '<div class="task-info">' +
        '<span class="task-info-item prog-item"><span class="task-info-label">进度</span><span class="task-info-value">' + prog.toFixed(1) + '%</span></span>' +
        '<span class="task-info-item speed-item"><span class="task-info-label">速度</span><span class="task-info-value">' + esc(speed) + '</span></span>' +
        '<span class="task-info-item eta-item"><span class="task-info-label">剩余</span><span class="task-info-value">' + esc(eta) + '</span></span>' +
    '</div>';
    
    var bottomRow = '<div class="task-bottom">' +
        '<div class="task-bottom-left">' + infoHtml + '</div>' +
        '<div class="task-bottom-right"><div class="task-actions">' + buildActionsHTML(t) + '</div></div>' +
    '</div>';

    card.innerHTML =
        '<div class="task-header">' +
            '<div class="task-title" title="' + esc(t.title) + '">' + esc(t.title) + '</div>' +
            '<div class="task-header-right">' + filesizeHtml +
                '<span class="task-status ' + t.status + '"' + statusExtra + '>' + (STATUS_TEXT[t.status] || t.status) + '</span>' +
            '</div>' +
        '</div>' +
        '<div class="task-mid-row">' + fmtHtml +
            '<div class="progress-bar-inline"><div class="' + fillClass + '" style="width:' + prog + '%"></div></div>' +
        '</div>' +
        bottomRow;
}

// ======================== 确认弹窗 ========================

var confirmCallback = null;

function showConfirm(title, message, onConfirm) {
    document.getElementById('confirm-title').textContent = title;
    document.getElementById('confirm-message').textContent = message;
    confirmCallback = onConfirm;
    
    var el = document.getElementById('confirm-overlay');
    el.offsetHeight;
    requestAnimationFrame(function() {
        el.classList.add('show');
    });
}

function hideConfirm() {
    _closeOverlay('confirm-overlay');
    confirmCallback = null;
}

function confirmOk() {
    if (typeof confirmCallback === 'function') {
        confirmCallback();
    }
    hideConfirm();
}

// ======================== 文件名浮窗 ========================

(function() {
    var tip = document.getElementById('title-tip');
    var _source = null;

    function showAt(el, text) {
        _source = el;
        tip.textContent = text;
        var card = el.closest('.task-card');
        var cr = card.getBoundingClientRect();
        tip.style.left = (cr.left + 12) + 'px';
        tip.style.width = (cr.width - 24) + 'px';
        tip.style.top = (el.getBoundingClientRect().bottom + 4) + 'px';
        tip.offsetHeight;
        requestAnimationFrame(function() { tip.classList.add('show'); });
    }

    function hide() {
        tip.classList.remove('show');
        _source = null;
    }

    window.addEventListener('scroll', function() { hide(); }, true);

    document.addEventListener('click', function(e) {
        var titleEl = e.target.closest('.task-title');
        var statusEl = e.target.closest('.task-status.failed');
        var target = titleEl || statusEl;
        if (!target) { hide(); return; }

        var text = titleEl
            ? (titleEl.getAttribute('title') || titleEl.textContent)
            : (statusEl.getAttribute('data-error') || '');

        if (target === _source) {
            // 点击同一个 → 关闭
            hide();
        } else {
            // 点击不同的 → 先关再开（有动画）
            if (tip.classList.contains('show')) {
                hide();
                var onDone = function() {
                    tip.removeEventListener('transitionend', onDone);
                    showAt(target, text);
                };
                tip.addEventListener('transitionend', onDone);
            } else {
                showAt(target, text);
            }
        }
    });
})();

// ======================== 任务操作 ========================

function pauseTask(id) {
    // 乐观更新：先改 UI 再发请求
    if (tasks[id]) { tasks[id].status = 'stopped'; tasks[id].stop_requested = true; }
    renderTasks();
    fetch('/api/pause', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({task_id:id})});
}
function resumeTask(id) {
    fetch('/api/resume', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({task_id:id})});
}
function retryTask(id) {
    fetch('/api/retry', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({task_id:id})});
}
function deleteTask(id) {
    _deletedIds[id] = Date.now() + 5000;
    delete tasks[id];
    renderTasks();
    fetch('/api/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({task_id:id})});
}
function stopAll() {
    Object.values(tasks).forEach(function(t) { if (t.status === 'downloading' || t.status === 'merging') { t.status = 'stopped'; t.stop_requested = true; } });
    renderTasks();
    toast('已暂停全部', 'warning');
    fetch('/api/stop_all', {method:'POST'});
}
function resumeAll() {
    var toResume = Object.values(tasks).filter(function(t) { return t.status === 'stopped' || t.status === 'failed'; });
    if (!toResume.length) { toast('没有需要继续的任务', 'info'); return; }
    fetch('/api/resume_all', {method:'POST'})
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
        if (data.status === 'ok') {
            if (data.started || data.queued) {
                toast('已继续 ' + data.started + ' 个，排队 ' + data.queued + ' 个', 'success');
            } else {
                toast('没有需要继续的任务', 'success');
            }
        }
    })
    .catch(function() { toast('请求失败', 'error'); });
}
function deleteAll() {
    // 删除所有除了已完成的任务
    var ids = Object.values(tasks)
        .filter(function(t) { return t.status !== 'finished'; })
        .map(function(t) { return t.id; });
    
    if (!ids.length) {
        toast('没有需要删除的任务', 'error');
        return;
    }
    
    showConfirm(
        '删除任务',
        '确定删除 ' + ids.length + ' 个未完成任务？',
        function() {
            // 乐观更新
            var expires = Date.now() + 5000;
            ids.forEach(function(id) { _deletedIds[id] = expires; delete tasks[id]; });
            renderTasks();
            toast('已删除 ' + ids.length + ' 个任务', 'error');
            // 后台发请求
            ids.forEach(function(id) {
                fetch('/api/delete', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({task_id:id})});
            });
        }
    );
}
function clearDone() {
    // 清除已完成的任务记录（不删除文件）
    var hasFinished = Object.values(tasks).some(function(t) {
        return t.status === 'finished';
    });
    
    if (!hasFinished) {
        toast('没有已完成的任务', 'info');
        return;
    }
    
    // 乐观更新
    var expires = Date.now() + 5000;
    Object.keys(tasks).forEach(function(id) { if (tasks[id].status === 'finished') { _deletedIds[id] = expires; delete tasks[id]; } });
    renderTasks();
    toast('已清除已完成任务', 'info');
    fetch('/api/clear', {method:'POST'});
}

// ======================== 设置 ========================

function toggleSettings() {
    var el = document.getElementById('settings-overlay');
    if (el.classList.contains('show')) {
        _closeOverlay('settings-overlay');
    } else {
        el.style.visibility = '';
        // 强制浏览器准备 GPU 层，然后下一帧开始动画
        el.offsetHeight;
        requestAnimationFrame(function() {
            el.classList.add('show');
            loadConfig();
        });
    }
}

// 关闭设置面板内所有下拉浮窗（由面板 onclick 调用）
function closeSettingsDropdowns() {
    if (typeof closeDirSelect === 'function') closeDirSelect();
    if (typeof closeRuleDropdown === 'function') closeRuleDropdown();
}

// 目录下拉选择器
(function() {
    var trigger, options, isOpen = false;

    function initDirSelect() {
        trigger = document.getElementById('dir-trigger');
        options = document.getElementById('dir-options');
        if (!trigger || !options) return;

        trigger.addEventListener('click', function(e) {
            e.stopPropagation();
            if (isOpen) { close(); return; }
            // 关闭路由规则下拉（互斥）
            if (typeof closeRuleDropdown === 'function') closeRuleDropdown();
            // 定位（相对 settings-overlay）
            var rect = trigger.getBoundingClientRect();
            var overlay = document.getElementById('settings-overlay');
            var overlayRect = overlay.getBoundingClientRect();
            options.style.top = (rect.bottom - overlayRect.top + 4) + 'px';
            options.style.left = (rect.left - overlayRect.left) + 'px';
            options.style.width = rect.width + 'px';
            // 高亮当前值
            var cur = document.getElementById('cfg-dir').value;
            var opts = options.querySelectorAll('.custom-select-option');
            for (var i = 0; i < opts.length; i++) {
                opts[i].classList.toggle('selected', opts[i].getAttribute('data-value') === cur);
            }
            requestAnimationFrame(function() {
                options.classList.add('show');
                trigger.classList.add('open');
                isOpen = true;
            });
        });

        options.addEventListener('click', function(e) {
            var opt = e.target.closest('.custom-select-option');
            if (!opt) return;
            var val = opt.getAttribute('data-value');
            document.getElementById('cfg-dir').value = val;
            document.getElementById('cfg-dir-text').textContent = val;
            close();
        });

        // 点击外部关闭
        document.addEventListener('click', function() {
            if (isOpen) close();
        });
    }

    function close() {
        if (!options || !trigger) return;
        options.classList.remove('show');
        trigger.classList.remove('open');
        isOpen = false;
    }

    // 暴露给外部
    window.closeDirSelect = close;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDirSelect);
    } else {
        initDirSelect();
    }
})();

function loadConfig() {
    fetch('/api/config')
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
        if (data.status !== 'ok') return;
        var c = data.data;
        var dirVal = c.download_dir || '/app/downloads';
        document.getElementById('cfg-dir').value = dirVal;
        document.getElementById('cfg-dir-text').textContent = dirVal;
        document.getElementById('cfg-max').value = c.max_tasks || 3;
        document.getElementById('cfg-frag').value = c.concurrent_fragments || 4;
        document.getElementById('cfg-thread').value = c.thread_count || 16;
        document.getElementById('cfg-cookies').value = c.cookies_file || '';
        // 加载路由规则
        renderRoutingRules(c.routing_rules || []);
    });
}

// ======================== 路由规则下拉管理 ========================

var _ruleDD = { el: null, trigger: null, cb: null };

function initRuleDropdown() {
    _ruleDD.el = document.getElementById('rule-dropdown');
    if (!_ruleDD.el) return;
    // 选项点击（挂在浮层元素上，比 document 的关闭处理器先触发）
    _ruleDD.el.addEventListener('click', function(e) {
        var opt = e.target.closest('.custom-select-option');
        if (!opt || !_ruleDD.trigger || !_ruleDD.cb) return;
        e.stopPropagation();
        var val = opt.getAttribute('data-value');
        var label = opt.textContent.trim();
        var valueEl = _ruleDD.trigger.querySelector('.custom-select-value');
        if (valueEl) valueEl.textContent = label;
        _ruleDD.trigger.setAttribute('data-value', val);
        var cb = _ruleDD.cb;
        closeRuleDropdown();
        cb(val);
    });
    // 点击外部关闭
    document.addEventListener('click', function() { closeRuleDropdown(); });
}

function openRuleDropdown(csEl, options, currentValue, cb) {
    // 如果点的是已经打开的那个触发器，直接关闭（切换）
    if (_ruleDD.trigger === csEl && _ruleDD.el && _ruleDD.el.classList.contains('show')) {
        closeRuleDropdown();
        return;
    }
    // 关闭目录下拉（互斥）
    if (typeof closeDirSelect === 'function') closeDirSelect();

    var el = _ruleDD.el;
    var switching = el && el.classList.contains('show');

    // 先关闭旧的
    if (_ruleDD.trigger) {
        var oldT = _ruleDD.trigger.querySelector('.custom-select-trigger');
        if (oldT) oldT.classList.remove('open');
    }
    _ruleDD.trigger = csEl;
    _ruleDD.cb = cb;

    function doOpen() {
        el.innerHTML = options.map(function(o) {
            return '<div class="custom-select-option' + (o.value === currentValue ? ' selected' : '') + '" data-value="' + esc(o.value) + '">' + esc(o.label) + '</div>';
        }).join('');
        var rect = csEl.getBoundingClientRect();
        var overlay = document.getElementById('settings-overlay');
        var oRect = overlay.getBoundingClientRect();
        el.style.top = (rect.bottom - oRect.top + 4) + 'px';
        el.style.left = (rect.left - oRect.left) + 'px';
        el.style.width = rect.width + 'px';
        csEl.querySelector('.custom-select-trigger').classList.add('open');
        requestAnimationFrame(function() { el.classList.add('show'); });
    }

    if (switching) {
        // 等旧浮窗关闭动画结束再打开新的
        el.classList.remove('show');
        el.addEventListener('transitionend', function handler(e) {
            if (e.target !== el) return;
            el.removeEventListener('transitionend', handler);
            doOpen();
        });
    } else {
        doOpen();
    }
}

function closeRuleDropdown() {
    if (!_ruleDD.el) return;
    _ruleDD.el.classList.remove('show');
    if (_ruleDD.trigger) {
        var t = _ruleDD.trigger.querySelector('.custom-select-trigger');
        if (t) t.classList.remove('open');
    }
    _ruleDD.trigger = null;
    _ruleDD.cb = null;
}
initRuleDropdown();

// ======================== 路由规则构建 ========================

var MATCH_OPTIONS = [
    { value: 'url_type', label: '链接类型' },
    { value: 'domain', label: '关键词' }
];
var URL_TYPE_OPTIONS = [
    { value: 'm3u8', label: 'm3u8' },
    { value: 'direct', label: '直链' },
    { value: 'other', label: '分享链接' }
];

function getOptLabel(options, value) {
    for (var i = 0; i < options.length; i++) {
        if (options[i].value === value) return options[i].label;
    }
    return value || '';
}

function createCsEl(field, options, currentValue) {
    var div = document.createElement('div');
    div.className = 'custom-select';
    div.setAttribute('data-field', field);
    div.setAttribute('data-value', currentValue || '');
    div.innerHTML =
        '<div class="custom-select-trigger">' +
            '<span class="custom-select-value">' + esc(getOptLabel(options, currentValue)) + '</span>' +
            '<span class="custom-select-arrow">▼</span>' +
        '</div>';
    div.querySelector('.custom-select-trigger').addEventListener('click', function(e) {
        e.stopPropagation();
        openRuleDropdown(div, options, div.getAttribute('data-value'), function(val) {
            if (field === 'match_type') onMatchTypeChange(div.parentElement, val);
        });
    });
    return div;
}

function buildRuleRow(matchType, pattern, dir) {
    var row = document.createElement('div');
    row.className = 'routing-rule-row';
    // 匹配规则
    var m = createCsEl('match_type', MATCH_OPTIONS, matchType);
    m.classList.add('cs-col-match');
    row.appendChild(m);
    // 匹配值
    if (matchType === 'url_type') {
        var p = createCsEl('pattern', URL_TYPE_OPTIONS, pattern);
        p.classList.add('cs-col-pattern');
        row.appendChild(p);
    } else {
        var inp = document.createElement('input');
        inp.className = 'custom-select-trigger rule-input cs-col-pattern';
        inp.setAttribute('data-field', 'pattern');
        inp.placeholder = '域名关键词（如 bilibili）';
        inp.value = pattern || '';
        row.appendChild(inp);
    }
    // 目标目录（手动输入）
    var dirInp = document.createElement('input');
    dirInp.className = 'custom-select-trigger rule-input cs-col-dir';
    dirInp.setAttribute('data-field', 'dir');
    dirInp.placeholder = '目标目录';
    dirInp.value = dir || '';
    row.appendChild(dirInp);
    // 删除
    var btn = document.createElement('button');
    btn.className = 'btn-sm danger';
    btn.textContent = '−';
    btn.onclick = function() {
        row.style.height = row.offsetHeight + 'px';
        row.offsetHeight;
        row.classList.add('rule-leave');
        row.style.height = '0';
        row.addEventListener('transitionend', function(e) { if (e.propertyName === 'height') row.remove(); });
    };
    row.appendChild(btn);
    return row;
}

function onMatchTypeChange(row, newType) {
    var old = row.querySelector('[data-field="pattern"]');
    if (!old) return;
    var newEl;
    if (newType === 'url_type') {
        newEl = createCsEl('pattern', URL_TYPE_OPTIONS, 'm3u8');
        newEl.classList.add('cs-col-pattern');
    } else {
        newEl = document.createElement('input');
        newEl.className = 'custom-select-trigger rule-input cs-col-pattern';
        newEl.setAttribute('data-field', 'pattern');
        newEl.placeholder = '域名关键词（如 bilibili）';
        newEl.value = '';
    }
    row.replaceChild(newEl, old);
}

function renderRoutingRules(rules) {
    var container = document.getElementById('routing-rules');
    container.innerHTML = '';
    rules.forEach(function(r) {
        container.appendChild(buildRuleRow(r.match_type, r.pattern, r.dir));
    });
}

function addRoutingRule() {
    var row = buildRuleRow('url_type', 'm3u8', '/app/downloads');
    row.classList.add('rule-enter');
    document.getElementById('routing-rules').appendChild(row);
    row.offsetHeight;
    requestAnimationFrame(function() { row.classList.remove('rule-enter'); });
}

function collectRoutingRules() {
    var rows = document.querySelectorAll('#routing-rules .routing-rule-row');
    var rules = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var mtEl = row.querySelector('[data-field="match_type"]');
        var patEl = row.querySelector('[data-field="pattern"]');
        var dirEl = row.querySelector('[data-field="dir"]');
        var mt = mtEl ? mtEl.getAttribute('data-value') : '';
        var pat = patEl ? (patEl.getAttribute('data-value') || patEl.value || '').trim() : '';
        var dir = dirEl ? (dirEl.getAttribute('data-value') || dirEl.value || '').trim() : '';
        if (pat && dir) rules.push({match_type: mt, pattern: pat, dir: dir});
    }
    return rules;
}

function saveConfig() {
    var cfg = {
        download_dir: document.getElementById('cfg-dir').value,
        max_tasks: parseInt(document.getElementById('cfg-max').value) || 3,
        concurrent_fragments: parseInt(document.getElementById('cfg-frag').value) || 4,
        thread_count: parseInt(document.getElementById('cfg-thread').value) || 16,
        cookies_file: document.getElementById('cfg-cookies').value,
        routing_rules: collectRoutingRules()
    };
    fetch('/api/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(cfg)
    })
    .then(function(r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function(data) {
        if (data.status === 'ok') {
            toast('配置已保存', 'success');
            toggleSettings();
        } else {
            toast('保存失败', 'error');
        }
    })
    .catch(function() { toast('请求失败', 'error'); });
}

// ======================== Toast ========================

function toast(msg, type) {
    type = type || 'info';
    var container = document.getElementById('toasts');
    // 清除已有提示，只保留一个
    var existing = container.querySelector('.toast');
    if (existing) existing.remove();
    var el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    container.appendChild(el);
    
    // 自动关闭
    setTimeout(function() {
        el.classList.add('toast-out');
        setTimeout(function() { el.remove(); }, 250);
    }, 3000);
}

// ======================== 防止单击选中文字 ========================

var isLongPress = false;
var selectionTimer = null;

// 触摸事件
document.addEventListener('touchstart', function(e) {
    isLongPress = false;
    
    if (!isInputElement(e.target)) {
        // 立即清除之前的选中
        document.getSelection().removeAllRanges();
        
        // 设置长按定时器
        selectionTimer = setTimeout(function() {
            isLongPress = true;
        }, 300);
    }
}, { passive: true });

document.addEventListener('touchend', function(e) {
    clearTimeout(selectionTimer);
    
    if (!isLongPress && !isInputElement(e.target)) {
        // 短按，清除选中
        document.getSelection().removeAllRanges();
    }
}, { passive: true });

document.addEventListener('touchmove', function(e) {
    // 移动时清除定时器，不算长按
    clearTimeout(selectionTimer);
}, { passive: true });

// 鼠标事件
document.addEventListener('mousedown', function(e) {
    isLongPress = false;
    
    if (!isInputElement(e.target)) {
        // 立即清除之前的选中
        document.getSelection().removeAllRanges();
        
        // 设置长按定时器
        selectionTimer = setTimeout(function() {
            isLongPress = true;
        }, 300);
    }
}, { passive: true });

document.addEventListener('mouseup', function(e) {
    clearTimeout(selectionTimer);
    
    if (!isLongPress && !isInputElement(e.target)) {
        // 短按，清除选中
        document.getSelection().removeAllRanges();
    }
}, { passive: true });

document.addEventListener('mousemove', function(e) {
    // 移动时清除定时器，不算长按
    clearTimeout(selectionTimer);
}, { passive: true });

function isInputElement(el) {
    var tagName = el.tagName.toLowerCase();
    return tagName === 'textarea' || 
           tagName === 'input' || 
           el.contentEditable === 'true';
}

// ======================== SSE 事件监听 ========================

var eventSource = null;

function initSSE() {
    if (eventSource) {
        eventSource.close();
    }
    
    eventSource = new EventSource('/api/events');
    
    eventSource.addEventListener('connected', function(e) {
        console.log('[SSE] Connected');
    });
    
    eventSource.addEventListener('task_update', function(e) {
        try {
            var data = JSON.parse(e.data);
            if (data.id) {
                // 忽略乐观删除的任务
                var exp = _deletedIds[data.id];
                if (exp) {
                    if (Date.now() < exp) return;
                    delete _deletedIds[data.id];
                }
                tasks[data.id] = data;
                // 记录下载中任务的最后进度时间
                if (data.status === 'downloading' || data.status === 'merging') {
                    _lastProgress[data.id] = Date.now();
                } else {
                    delete _lastProgress[data.id];
                }
                // 只更新这一个卡片，不遍历全部
                var card = document.querySelector('.task-card[data-id="' + data.id + '"]');
                if (card) {
                    updateCard(card, data);
                } else {
                    renderTasks();
                }
                updateHeaderStats();
            }
        } catch(ex) {
            console.error('[SSE] task_update error:', ex);
        }
    });
    
    eventSource.addEventListener('task_delete', function(e) {
        try {
            var data = JSON.parse(e.data);
            if (tasks[data.id]) {
                delete tasks[data.id];
                _lastTasksJson = '';  // 标记需要重新拉取
                renderTasks();
                updateHeaderStats();
            }
        } catch(ex) {
            loadTasks();
        }
    });
    
    eventSource.onerror = function(e) {
        console.error('[SSE] Error, reconnecting in 3s...');
        setTimeout(function() {
            initSSE();
            loadTasks(true);
        }, 3000);
    };
}

// ======================== 初始化 ========================

document.addEventListener('DOMContentLoaded', function() {
    loadTasks();
    initSSE();
    
    // 页面从后台切回前台时立即刷新，后台时暂停定时器
    document.addEventListener('visibilitychange', function() {
        if (!document.hidden) {
            loadTasks(true);  // 立即执行，不防抖
            // 恢复进度检查定时器
            if (!_progressTimer) {
                _progressTimer = setInterval(_checkProgressTimeout, 3000);
            }
        } else {
            // 暂停进度检查定时器，节省后台 CPU
            if (_progressTimer) {
                clearInterval(_progressTimer);
                _progressTimer = null;
            }
        }
    });
    
    // 页面关闭时断开 SSE
    window.addEventListener('beforeunload', function() {
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
    });
    
    // 悬浮框拖动
    initFloatingStats();

    // 移动端修复：键盘弹出时 fixed 面板 click 坐标偏移，
    // touchend 坐标正确，在 touchend 上拦截保存按钮
    var settingsPanel = document.getElementById('settings-overlay');
    if (settingsPanel) {
        settingsPanel.addEventListener('touchend', function(e) {
            var btn = e.target.closest('.btn-primary');
            if (!btn) return;
            e.preventDefault();
            saveConfig();
        });
    }

    // 定时检查：下载中任务超过 5 秒没收到进度，清零速度和剩余时间
    function _checkProgressTimeout() {
        var now = Date.now();
        Object.keys(_lastProgress).forEach(function(id) {
            if (now - _lastProgress[id] > 3000) {
                var card = document.querySelector('.task-card[data-id="' + id + '"]');
                if (card) {
                    var infoEl = card.querySelector('.task-info');
                    if (infoEl) {
                        var prog = (tasks[id] && tasks[id].progress) || 0;
                        infoEl.innerHTML =
                            '<span class="task-info-item prog-item"><span class="task-info-label">进度</span><span class="task-info-value">' + prog.toFixed(1) + '%</span></span>' +
                            '<span class="task-info-item speed-item"><span class="task-info-label">速度</span><span class="task-info-value">0 B/s</span></span>' +
                            '<span class="task-info-item eta-item"><span class="task-info-label">剩余</span><span class="task-info-value">--</span></span>';
                    }
                    var speedEl = card.querySelector('.task-speed');
                    if (speedEl) speedEl.textContent = '';
                }
                delete _lastProgress[id];
            }
        });
    }
    _progressTimer = setInterval(_checkProgressTimeout, 3000);
});

// ======================== 悬浮框拖动 ========================

function initFloatingStats() {
    var el = document.getElementById('floating-stats');
    if (!el) return;
    
    var isDragging = false;
    var startX, startY, startLeft, startTop;
    
    // 从 localStorage 恢复位置
    var savedPos = localStorage.getItem('floatingStatsPos');
    if (savedPos) {
        try {
            var pos = JSON.parse(savedPos);
            el.style.left = pos.left + 'px';
            el.style.top = pos.top + 'px';
            el.style.right = 'auto';
        } catch(e) {}
    }
    
    // 双击切换显示/隐藏
    document.addEventListener('dblclick', function(e) {
        // 忽略输入框、按钮等元素上的双击
        var tagName = e.target.tagName.toLowerCase();
        if (tagName === 'textarea' || tagName === 'input' || tagName === 'button' || 
            tagName === 'select' || e.target.closest('.settings-overlay') || 
            e.target.closest('.format-panel') || e.target.closest('.confirm-overlay')) {
            return;
        }
        el.classList.toggle('show');
        localStorage.setItem('floatingStatsVisible', el.classList.contains('show'));
    });
    
    // 恢复显示状态
    var savedVisible = localStorage.getItem('floatingStatsVisible');
    if (savedVisible === 'true') {
        el.classList.add('show');
    }
    
    el.addEventListener('mousedown', function(e) {
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = el.offsetLeft;
        startTop = el.offsetTop;
        el.style.transition = 'none';
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', function(e) {
        if (!isDragging) return;
        e.preventDefault();
        var dx = e.clientX - startX;
        var dy = e.clientY - startY;
        var newLeft = startLeft + dx;
        var newTop = startTop + dy;
        
        // 边界限制
        var maxLeft = window.innerWidth - el.offsetWidth;
        var maxTop = window.innerHeight - el.offsetHeight;
        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));
        
        el.style.left = newLeft + 'px';
        el.style.top = newTop + 'px';
        el.style.right = 'auto';
    });
    
    document.addEventListener('mouseup', function() {
        if (isDragging) {
            isDragging = false;
            el.style.transition = 'var(--transition)';
            // 保存位置
            localStorage.setItem('floatingStatsPos', JSON.stringify({
                left: el.offsetLeft,
                top: el.offsetTop
            }));
        }
    });
    
    // 触摸支持
    el.addEventListener('touchstart', function(e) {
        isDragging = true;
        var touch = e.touches[0];
        startX = touch.clientX;
        startY = touch.clientY;
        startLeft = el.offsetLeft;
        startTop = el.offsetTop;
        el.style.transition = 'none';
        e.stopPropagation();
    }, { passive: false });
    
    document.addEventListener('touchmove', function(e) {
        if (!isDragging) return;
        e.preventDefault();
        var touch = e.touches[0];
        var dx = touch.clientX - startX;
        var dy = touch.clientY - startY;
        var newLeft = startLeft + dx;
        var newTop = startTop + dy;
        
        var maxLeft = window.innerWidth - el.offsetWidth;
        var maxTop = window.innerHeight - el.offsetHeight;
        newLeft = Math.max(0, Math.min(newLeft, maxLeft));
        newTop = Math.max(0, Math.min(newTop, maxTop));
        
        el.style.left = newLeft + 'px';
        el.style.top = newTop + 'px';
        el.style.right = 'auto';
    }, { passive: false });
    
    document.addEventListener('touchend', function() {
        if (isDragging) {
            isDragging = false;
            el.style.transition = 'var(--transition)';
            localStorage.setItem('floatingStatsPos', JSON.stringify({
                left: el.offsetLeft,
                top: el.offsetTop
            }));
        }
    });
}
