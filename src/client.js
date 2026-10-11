// DSH's browser loader expects a lazy CommonJS factory, not an ESM bundle.
window.__ModuleLoader__.load({
  id: 'dsh-provider-extensions',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const NS = 'llm-cline-pass';
    const STYLE_ID = 'dsh-provider-extensions-style';
    // The 0.2.0 card renders inside the host's Models rows, which carry that
    // page's CSS-module classes, so the panel ships its own scoped stylesheet.
    const CSS = `
.dshpe-panel { display: flex; flex-direction: column; gap: 12px; margin-top: 12px; padding: 12px; border: 1px solid var(--dsh-border, rgba(128, 128, 128, 0.28)); border-radius: 8px; font-size: 13px; }
.dshpe-panel > summary { cursor: pointer; font-weight: 600; list-style-position: inside; }
.dshpe-status { font-weight: 400; opacity: 0.7; margin-left: 8px; }
.dshpe-field { display: flex; flex-direction: column; gap: 4px; }
.dshpe-label { opacity: 0.8; font-size: 12px; }
.dshpe-input { width: 100%; box-sizing: border-box; padding: 6px 8px; border: 1px solid var(--dsh-border, rgba(128, 128, 128, 0.4)); border-radius: 6px; background: var(--dsh-input-background, transparent); color: inherit; font: inherit; }
.dshpe-row { display: flex; gap: 8px; align-items: flex-end; }
.dshpe-check { display: flex; align-items: center; gap: 6px; }
.dshpe-hint { opacity: 0.7; font-size: 12px; margin: 0; }
.dshpe-error { color: var(--dsh-danger, #d9534f); margin: 0; }
.dshpe-models { display: flex; flex-direction: column; gap: 8px; }
.dshpe-model { display: flex; gap: 6px; align-items: center; }
.dshpe-actions { display: flex; gap: 8px; justify-content: flex-end; }
.dshpe-button { padding: 5px 12px; border-radius: 6px; border: 1px solid var(--dsh-border, rgba(128, 128, 128, 0.4)); background: transparent; color: inherit; font: inherit; cursor: pointer; }
.dshpe-button[data-primary] { background: var(--dsh-accent, #4a6cf7); border-color: transparent; color: #fff; }
.dshpe-button:disabled { opacity: 0.5; cursor: default; }
.dshpe-link { border: none; background: none; color: inherit; opacity: 0.8; text-decoration: underline; cursor: pointer; font: inherit; padding: 0; }
.dshpe-picker { display: flex; flex-direction: column; gap: 6px; max-height: 240px; overflow: auto; border: 1px solid var(--dsh-border, rgba(128, 128, 128, 0.28)); border-radius: 6px; padding: 8px; }
.dshpe-option { display: flex; gap: 8px; align-items: center; }
.dshpe-option span { opacity: 0.7; font-size: 12px; }
`;
    const fields = ['routing', 'upstream', 'timeoutMs', 'diagnostics', 'models'];
    const defaults = { routing: 'sticky', upstream: '', timeoutMs: 300000, diagnostics: false, models: [] };
    // Mirrors the host schema's `role('credential-ref')` defaults.
    const envOf = command => command ? 'COMMANDCODE_API_KEY' : 'CLINEPASS_API_KEY';
    const draftOf = value => ({ ...defaults, ...structuredClone(value ?? {}) });
    const keyPathOf = command => command ? 'commandcode' : 'profile';
    const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
    function applyKeyStyle() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const copy = {
      zh: {
        settings: 'ClinePass 设置', commandSettings: 'Command Code 设置', settingsSummary: '自定义设置',
        configured: '已配置', dormant: '尚未配置', keyStored: '已保存密钥', keyMissing: '未配置密钥',
        keyInput: 'API 密钥', keyPlaceholder: '粘贴 API 密钥', applying: '正在应用…', apply: '应用',
        restore: '恢复默认设置', cancel: '取消', addModel: '添加模型', removeModel: '删除模型',
        models: '模型列表', modelId: '模型 ID', modelName: '显示名称', contextWindow: '上下文容量',
        maxTokens: '输出上限', routing: '路由策略', timeout: '请求超时（毫秒）', diagnostics: '诊断日志',
        diagnosticsHint: '记录 token 用量和耗时', upstream: '上游提供方', upstreamHint: '提供方标识',
        routingDefault: '默认', routingSticky: '会话黏性', routingPin: '固定上游（实验性）',
        pinHint: '上游是否执行此限制尚未验证，缓存命中无法保证。',
        keyFormat: '请输入 API 密钥本身，不要包含变量名、引号或空白字符。',
        keyRequired: '请输入 API 密钥。', upstreamRequired: '请输入上游提供方标识。',
        timeoutInvalid: '请求超时需为 1000 到 1800000 毫秒。',
        modelPrefix: '模型 ID 必须以 cline-pass/ 开头。', modelIdRequired: '请输入模型 ID。',
        modelInvalid: '模型容量需为正整数。', modelDuplicate: '模型 ID 不能重复。',
        unavailable: '设置暂不可用。', conflict: '设置已被其他操作修改，请重试。', keyWriteFailed: '密钥保存失败。',
        discover: '获取可用模型', discovering: '正在获取…', discoverFailed: '模型目录获取失败。',
        noDetail: '（宿主未返回错误详情，详见浏览器控制台）',
        modelsInherited: '列表留空：自动读取 ClinePass 官方目录（cline-pass/* 订阅模型），无需手动添加；点“获取可用模型”可挑选子集写入配置。',
        modelsInheritedCommand: '列表留空：自动读取 Command Code 官方目录，无需手动添加；点“获取可用模型”可挑选子集写入配置。',
        pickerTitle: '选择要添加的模型', addSelected: '添加所选', selectAll: '全选', selectNone: '取消全选',
        searchModels: '搜索模型', closePicker: '关闭', catalogEmpty: '目录没有可添加的模型。',
      },
      en: {
        settings: 'ClinePass settings', commandSettings: 'Command Code settings', settingsSummary: 'Customized settings',
        configured: 'Configured', dormant: 'Not configured', keyStored: 'API key saved', keyMissing: 'API key missing',
        keyInput: 'API key', keyPlaceholder: 'Paste the API key', applying: 'Applying…', apply: 'Apply',
        restore: 'Restore defaults', cancel: 'Cancel', addModel: 'Add model', removeModel: 'Remove model',
        models: 'Models', modelId: 'Model ID', modelName: 'Display name', contextWindow: 'Context window',
        maxTokens: 'Max output tokens', routing: 'Routing', timeout: 'Request timeout (ms)', diagnostics: 'Diagnostic logs',
        diagnosticsHint: 'Record token usage and timing', upstream: 'Upstream provider', upstreamHint: 'Provider ID',
        routingDefault: 'Default', routingSticky: 'Session affinity', routingPin: 'Fixed upstream (experimental)',
        pinHint: 'Enforcement by the upstream service is unverified; cache hits are not guaranteed.',
        keyFormat: 'Enter the API key without a variable name, quotes or whitespace.',
        keyRequired: 'Enter the API key.', upstreamRequired: 'Enter an upstream provider ID.',
        timeoutInvalid: 'Request timeout must be between 1000 and 1800000 ms.',
        modelPrefix: 'Model IDs must start with cline-pass/.', modelIdRequired: 'Enter a model ID.',
        modelInvalid: 'Model limits must be positive integers.', modelDuplicate: 'Model IDs must be unique.',
        unavailable: 'Settings are unavailable.', conflict: 'Settings changed elsewhere; try again.', keyWriteFailed: 'The API key was not saved.',
        discover: 'Fetch available models', discovering: 'Fetching…', discoverFailed: 'The model catalog could not be fetched.',
        noDetail: '(the host returned no error detail; see the browser console)',
        modelsInherited: 'Empty list: the ClinePass catalog (cline-pass/* subscription models) is read automatically, so nothing has to be added by hand. "Fetch available models" copies a chosen subset into the configuration.',
        modelsInheritedCommand: 'Empty list: the Command Code catalog is read automatically, so nothing has to be added by hand. "Fetch available models" copies a chosen subset into the configuration.',
        pickerTitle: 'Choose models to add', addSelected: 'Add selected', selectAll: 'Select all', selectNone: 'Select none',
        searchModels: 'Search models', closePicker: 'Close', catalogEmpty: 'The catalog offers no new models.',
      },
    };
    /** Card body: the API key, the curated options and an atomic write. */
    function Card(props) {
      applyKeyStyle();
      const { provider, configured, configForms, credentials, remote, t } = props;      const command = provider?.provider === 'commandcode';
      const profilePath = keyPathOf(command);
      const savedFields = command ? ['models', 'timeoutMs'] : fields;
      const form = React.useMemo(() => configForms.get(provider?.settingsNs ?? NS), [configForms, provider?.settingsNs]);
      const snapshot = React.useSyncExternalStore(
        React.useCallback(listener => form.subscribe(listener), [form]),
        React.useCallback(() => form.getSnapshot(), [form]));
      const saved = snapshot.value?.[profilePath] ?? {};
      const ref = saved.apiKeyEnv ?? envOf(command);
      const [draft, setDraft] = React.useState(() => draftOf(saved));
      const [revision, setRevision] = React.useState(snapshot.revision);
      const [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const [apiKey, setApiKey] = React.useState('');
      const [credential, setCredential] = React.useState(undefined);
      const [catalog, setCatalog] = React.useState(null);
      const [chosen, setChosen] = React.useState({});
      const [query, setQuery] = React.useState('');
      const [fetching, setFetching] = React.useState(false);
      // Adopt the host value whenever an edit did not start locally: a write
      // from another tab, or a reload after this card's own apply.
      React.useEffect(() => {
        if (dirty || snapshot.revision === revision) return;
        setDraft(draftOf(saved));
        setRevision(snapshot.revision);
      }, [snapshot.revision, dirty, revision, snapshot.value]);
      React.useEffect(() => {
        let active = true;
        Promise.resolve(credentials.describe([ref]))
          .then(result => { if (active && result?.ok) setCredential(result.value[ref]); })
          .catch(() => {});
        return () => { active = false; };
      }, [credentials, ref, snapshot.revision]);
      /** Every field the card owns, as the values a save should leave behind. */
      const normalized = value => {
        const models = [];
        for (const model of value.models ?? []) {
          const item = { id: model.id, ...(model.name ? { name: model.name } : {}) };
          for (const key of ['contextWindow', 'maxTokens']) {
            const raw = model[key];
            if (raw === undefined || raw === '' || raw === null) continue;
            item[key] = Number(raw);
          }
          models.push(item);
        }
        return { ...value, upstream: (value.upstream ?? '').trim(), timeoutMs: Number(value.timeoutMs), models };
      };
      /** Path operations, so a live form write never restates a field it did not change. */
      const operations = next => {
        const before = saved;
        const ops = [];
        for (const field of savedFields) {
          const value = next[field];
          const present = field !== 'models' || next.models.length > 0;
          if (!present) { if (before[field] !== undefined) ops.push({ op: 'unset', path: [profilePath, field] }); continue; }
          if (same(before[field], value)) continue;
          ops.push({ op: 'set', path: [profilePath, field], value });
        }
        if (before.apiKeyEnv !== ref) ops.push({ op: 'set', path: [profilePath, 'apiKeyEnv'], value: ref });
        return ops;
      };
      /** Client-side validation; the host schema is the second gate. */
      const problem = (next, nextKey) => {
        if (nextKey && (!/^[\x21-\x7E]+$/.test(nextKey) || /^[A-Z_][A-Z0-9_]*=/.test(nextKey) || /^["'].*["']$/.test(nextKey))) return t('keyFormat');
        if (!Number.isInteger(next.timeoutMs) || next.timeoutMs < 1000 || next.timeoutMs > 1800000) return t('timeoutInvalid');
        if (!command && next.routing === 'experimental-pin' && !next.upstream) return t('upstreamRequired');
        const seen = new Set();
        for (const model of next.models) {
          if (!model.id) return t('modelIdRequired');
          if (!command && !/^cline-pass\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model.id)) return t('modelPrefix');
          if (seen.has(model.id)) return t('modelDuplicate');
          seen.add(model.id);
          for (const key of ['contextWindow', 'maxTokens']) {
            const raw = model[key];
            if (raw === undefined || raw === '' || raw === null) continue;
            if (!Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) return t('modelInvalid');
          }
        }
      };
      const execute = async action => {
        setBusy(true); setNotice('');
        try { await action(); } catch { setNotice(t('conflict')); } finally { setBusy(false); }
      };
      const change = (key, value) => { setDirty(true); setNotice(''); setDraft(old => ({ ...old, [key]: value })); };
      const modelChange = (index, key, value) => change('models', draft.models.map((model, position) => position === index ? { ...model, [key]: value } : model));
      const save = () => execute(async () => {
        const next = normalized(draft);
        const nextKey = apiKey.trim();
        const failure = problem(next, nextKey);
        if (failure) { setNotice(failure); return; }
        if (!configured && !nextKey && credential?.configured !== true) { setNotice(t('keyRequired')); return; }
        // Settings commit first, so a failed credential stage retries only that
        // stage and the row already carries its namespace and reference.
        if (!await form.mutate(operations(next), revision)) { setNotice(t('conflict')); return; }
        const settled = form.getSnapshot();
        if (nextKey) {
          const written = await credentials.set(ref, nextKey);
          if (!written?.ok) { setNotice(t('keyWriteFailed')); return; }
          setApiKey('');
        }
        setRevision(settled.revision);
        setDirty(false);
      });
      const restore = () => { setDraft(draftOf({})); setDirty(true); setNotice(''); };
      const reset = () => { setDraft(draftOf(saved)); setDirty(false); setNotice(''); };
      /**
       * Interrogate the provider catalog through the host's registered
       * discovery handler. The reply is candidate metadata; nothing is written
       * until the draft is applied, and existing rows keep their own values.
       */
      const discover = async () => {
        setFetching(true); setNotice('');
        const ns = provider?.settingsNs ?? NS;
        const request = { provider: provider?.provider };
        try {
          const response = await remote.llm.discoverModels(ns, request);
          // The remote answers `{ ok, value }`; accept a raw array or an
          // already-normalized `{ kind }` reply too, so this card survives
          // either caller shape.
          const envelope = Array.isArray(response) ? { ok: true, value: response } : response;
          const answer = envelope?.kind !== undefined ? envelope
            : envelope?.ok ? { kind: 'found', models: envelope.value }
              : { kind: 'refused', message: envelope?.error?.message, code: envelope?.error?.code };
          if (answer.kind !== 'found') {
            const reason = [answer.code && `code=${answer.code}`, answer.message].filter(Boolean).join(' ');
            console.error('[dsh-provider-extensions] model discovery refused', { ns, request, response, answer });
            setNotice(`${t('discoverFailed')} [${ns}/${request.provider ?? '-'}] ${reason || t('noDetail')}`);
            return;
          }
          const known = new Set(draft.models.map(model => model.id));
          const offered = (answer.models ?? []).filter(model => model?.id && !known.has(model.id));
          if (offered.length === 0) {
            console.error('[dsh-provider-extensions] model discovery returned nothing to add', { ns, request, total: (answer.models ?? []).length });
            setNotice(`${t('catalogEmpty')} [${ns}/${request.provider ?? '-'}] ${(answer.models ?? []).length}`);
            return;
          }
          setCatalog(offered);
          setChosen(Object.fromEntries(offered.map(model => [model.id, true])));
          setQuery('');
        } catch (error) {
          console.error('[dsh-provider-extensions] model discovery failed', { ns, request, error });
          const detail = error instanceof Error && error.message
            ? `${error.name}: ${error.message}`
            : JSON.stringify(error) || t('noDetail');
          setNotice(`${t('discoverFailed')} [${ns}/${request.provider ?? '-'}] ${detail}`);
        } finally { setFetching(false); }
      };
      const addChosen = () => {
        const added = (catalog ?? []).filter(model => chosen[model.id]);
        setCatalog(null);
        if (added.length === 0) return;
        change('models', [...draft.models.filter(model => model.id), ...added.map(model => ({ ...model }))]);
      };
      const disabled = busy || !snapshot.writable || credential?.writable === false;
      const keyLocked = credential?.writable === false;
      const label = (title, child) => h('label', { className: 'dshpe-field' }, h('span', { className: 'dshpe-label' }, title), child);
      const input = (value, onChange, extra = {}) => h('input', { className: 'dshpe-input', value, onChange: event => onChange(event.target.value), disabled, ...extra });
      const body = snapshot.status === 'ready' ? h(React.Fragment, null,
        label(t('keyInput'), input(apiKey, setApiKey, {
          type: 'password', autoComplete: 'new-password', placeholder: t(keyLocked ? 'keyStored' : credential?.configured ? 'keyStored' : 'keyPlaceholder'),
          'aria-label': t('keyInput'), disabled: disabled || keyLocked,
        })),
        h('div', { className: 'dshpe-models' },
          h('span', { className: 'dshpe-label' }, t('models')),
          draft.models.length === 0 ? h('p', { className: 'dshpe-hint' }, command ? t('modelsInheritedCommand') : t('modelsInherited')) : null,
          draft.models.map((model, index) => h('div', { className: 'dshpe-model', key: index },
            input(model.id ?? '', value => modelChange(index, 'id', value), { 'aria-label': `${t('modelId')} ${index + 1}`, placeholder: command ? t('modelId') : 'cline-pass/model-id' }),
            input(model.name ?? '', value => modelChange(index, 'name', value), { 'aria-label': `${t('modelName')} ${index + 1}`, placeholder: t('modelName') }),
            input(model.contextWindow ?? '', value => modelChange(index, 'contextWindow', value), { type: 'number', min: 1, 'aria-label': `${t('contextWindow')} ${index + 1}`, placeholder: t('contextWindow') }),
            input(model.maxTokens ?? '', value => modelChange(index, 'maxTokens', value), { type: 'number', min: 1, 'aria-label': `${t('maxTokens')} ${index + 1}`, placeholder: t('maxTokens') }),
            h('button', { type: 'button', className: 'dshpe-link', disabled, 'aria-label': t('removeModel'), onClick: () => change('models', draft.models.filter((_, position) => position !== index)) }, '×'))),
          h('button', { type: 'button', className: 'dshpe-link', disabled, onClick: () => change('models', [...draft.models, { id: '' }]) }, `+ ${t('addModel')}`),
          h('button', { type: 'button', className: 'dshpe-link', disabled: fetching, onClick: discover }, fetching ? t('discovering') : t('discover'))),
        catalog === null ? null : h('div', { className: 'dshpe-picker', role: 'group', 'aria-label': t('pickerTitle') },
          h('div', { className: 'dshpe-row' },
            h('input', { className: 'dshpe-input', value: query, placeholder: t('searchModels'), 'aria-label': t('searchModels'), onChange: event => setQuery(event.target.value) }),
            h('button', { type: 'button', className: 'dshpe-link', onClick: () => setChosen(Object.fromEntries(catalog.map(model => [model.id, true]))) }, t('selectAll')),
            h('button', { type: 'button', className: 'dshpe-link', onClick: () => setChosen({}) }, t('selectNone'))),
          catalog.filter(model => !query || model.id.toLowerCase().includes(query.toLowerCase()) || (model.name ?? '').toLowerCase().includes(query.toLowerCase()))
            .map(model => h('label', { className: 'dshpe-option', key: model.id },
              h('input', { type: 'checkbox', checked: chosen[model.id] === true, 'aria-label': model.id, onChange: event => setChosen(old => ({ ...old, [model.id]: event.target.checked })) }),
              model.id, model.name ? h('span', null, model.name) : null,
              model.contextWindow ? h('span', null, `context ${model.contextWindow}`) : null)),
          h('div', { className: 'dshpe-actions' },
            h('button', { type: 'button', className: 'dshpe-link', onClick: () => setCatalog(null) }, t('closePicker')),
            h('button', { type: 'button', className: 'dshpe-button', 'data-primary': true, onClick: addChosen }, t('addSelected')))),
        command ? null : label(t('routing'), h('select', { className: 'dshpe-input', value: draft.routing, disabled, 'aria-label': t('routing'), onChange: event => change('routing', event.target.value) },
          h('option', { value: 'default' }, t('routingDefault')),
          h('option', { value: 'sticky' }, t('routingSticky')),
          h('option', { value: 'experimental-pin' }, t('routingPin')))),
        !command && draft.routing === 'experimental-pin' ? label(t('upstream'), input(draft.upstream, value => change('upstream', value), { placeholder: t('upstreamHint'), 'aria-label': t('upstream') })) : null,
        !command && draft.routing === 'experimental-pin' ? h('p', { className: 'dshpe-hint' }, t('pinHint')) : null,
        label(t('timeout'), input(draft.timeoutMs, value => change('timeoutMs', value), { type: 'number', min: 1000, max: 1800000, 'aria-label': t('timeout') })),
        command ? null : h('label', { className: 'dshpe-check' }, h('input', { type: 'checkbox', checked: draft.diagnostics, disabled, 'aria-label': t('diagnostics'), onChange: event => change('diagnostics', event.target.checked) }), `${t('diagnostics')} — ${t('diagnosticsHint')}`)) : null;
      if (snapshot.status !== 'ready' && snapshot.status !== 'loading') return h('p', { className: 'dshpe-hint', 'data-cline-pass-settings': true }, t('unavailable'));
      const status = configured ? (credential?.configured ? t('keyStored') : t('configured')) : t('dormant');
      const actions = h('div', { className: 'dshpe-actions' },
        h('button', { type: 'button', className: 'dshpe-link', disabled, onClick: restore }, t('restore')),
        dirty ? h('button', { type: 'button', className: 'dshpe-button', disabled, onClick: reset }, t('cancel')) : null,
        h('button', { type: 'button', className: 'dshpe-button', 'data-primary': true, disabled, onClick: save }, busy ? t('applying') : t('apply')));
      const content = h(React.Fragment, null, body, notice ? h('p', { className: 'dshpe-error', role: 'alert' }, notice) : null, actions);
      // A saved row keeps the panel collapsed; the add-provider draft is the
      // one posture that must open its fields immediately.
      return configured
        ? h('details', { className: 'dshpe-panel', 'data-cline-pass-settings': true, 'data-provider': provider?.provider },
          h('summary', null, command ? t('commandSettings') : t('settings'), h('span', { className: 'dshpe-status' }, status)), content)
        : h('div', { className: 'dshpe-panel', 'data-cline-pass-settings': true, 'data-provider': provider?.provider },
          h('span', { className: 'dshpe-label' }, command ? t('commandSettings') : t('settings')), content);
    }
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, copy), 'dsh-provider-extensions: copy dictionaries');
      const t = ctx.locale.bind(NS);
      // The card reads its services from the live context at render time, the
      // way the shipped Models page does, so a late-arriving remote still works.
      const Panel = props => Card({ ...props, configForms: ctx.configForms, credentials: ctx.remote?.credentials, remote: ctx.remote, t });
      // 0.2.0 declares the keyed seat for out-of-repo plugins; the key is the
      // plugin's settings namespace, which is the profile entry id.
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({ name: 'settings.models.provider-card', key: NS, id: NS }, Panel));
    }
    return { inject: ['slots', 'remote', 'remote.credentials', 'remote.llm', 'configForms', 'locale'], apply };
  },
});
