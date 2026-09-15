// DSH's browser loader expects a lazy CommonJS factory, not an ESM bundle.
window.__ModuleLoader__.load({
  id: 'dsh-provider-extensions',
  factory: require => {
    const React = require('react');
    const h = React.createElement;
    const NS = 'llm-cline-pass';
    const fields = ['routing', 'upstream', 'timeoutMs', 'diagnostics', 'models'];
    const draftOf = value => ({ routing: value?.routing ?? 'sticky', upstream: value?.upstream ?? '', timeoutMs: value?.timeoutMs ?? 300000, diagnostics: value?.diagnostics ?? false, models: structuredClone(value?.models ?? []) });
    function apply(ctx) {
      const scope = ctx.settingsScope.bind({ namespace: NS });
      function Card(props) {
        const command = props.provider === 'commandcode';
        const profilePath = command ? 'commandcode' : 'profile';
        const savedFields = command ? ['models', 'timeoutMs'] : fields;
        const { styles: css, t, EditorFooter, ModelListEditor } = props;
        const zh = t('cancel') === '取消';
        const copy = (cn, en) => zh ? cn : en;
        const rootSnapshot = React.useSyncExternalStore(scope.subscribe.bind(scope), scope.getSnapshot.bind(scope));
        const snapshot = React.useMemo(() => ({ ...rootSnapshot, value: rootSnapshot.value?.[profilePath] ?? {} }), [rootSnapshot, profilePath]);
        const [draft, setDraft] = React.useState(() => draftOf(snapshot.value));
        const [revision, setRevision] = React.useState(snapshot.revision);
        const [dirty, setDirty] = React.useState(false);
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState('');
        const [apiKey, setApiKey] = React.useState('');
        const [credential, setCredential] = React.useState(null);
        const [candidates, setCandidates] = React.useState(null);
        const [selected, setSelected] = React.useState([]);
        const ref = snapshot.value?.apiKeyEnv ?? (command ? 'COMMANDCODE_API_KEY' : 'CLINEPASS_API_KEY');
        React.useEffect(() => { let active = true; ctx.remote.credentials.describe([ref]).then(result => { if (active && result.ok) setCredential(result.value[ref]); }).catch(() => {}); return () => { active = false; }; }, [ref, snapshot.revision]);
        React.useEffect(() => {
          if (!dirty) { setDraft(draftOf(snapshot.value)); setRevision(snapshot.revision); }
        }, [snapshot, dirty]);
        const change = (key, value) => { setDirty(true); setNotice(''); setDraft(old => ({ ...old, [key]: value })); };
        const modelChange = (index, key, value) => change('models', draft.models.map((m, i) => i === index ? { ...m, [key]: value } : m));
        const execute = async action => { setBusy(true); setNotice(''); try { await action(); } catch { setNotice(t('conflict')); } finally { setBusy(false); } };
        const save = () => execute(async () => {
          if (apiKey && (!/^[\x21-\x7E]+$/.test(apiKey.trim()) || /^[A-Z_][A-Z0-9_]*=/.test(apiKey.trim()) || /^["'].*["']$/.test(apiKey.trim()))) { setNotice(copy('请输入 API 密钥本身，不要包含变量名、引号或空白字符。', 'Enter the API key without a variable name, quotes or whitespace.')); return; }
          if (draft.routing === 'experimental-pin' && !draft.upstream.trim()) { setNotice(copy('请输入上游提供方标识。', 'Enter an upstream provider ID.')); return; }
          if (!Number.isInteger(Number(draft.timeoutMs)) || Number(draft.timeoutMs) < 1000 || Number(draft.timeoutMs) > 1800000) { setNotice(copy('请求超时需为 1000 到 1800000 毫秒。', 'Request timeout must be between 1000 and 1800000 ms.')); return; }
          const models = [];
          for (const model of draft.models) {
            if (!model.id?.trim() || !command && !/^cline-pass\/[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model.id ?? '')) { setNotice(command ? t('modelIdRequired') : copy('模型 ID 必须以 cline-pass/ 开头。', 'Model IDs must start with cline-pass/.')); return; }
            const item = { id: model.id, ...(model.name ? { name: model.name } : {}) };
            for (const key of ['contextWindow', 'maxTokens']) {
              if (model[key] !== undefined && model[key] !== '') {
                if (!Number.isSafeInteger(Number(model[key])) || Number(model[key]) <= 0) { setNotice(t('modelContextInvalid')); return; }
                item[key] = Number(model[key]);
              }
            }
            if (models.some(m => m.id === item.id)) { setNotice(t('modelIdDuplicate')); return; }
            models.push(item);
          }
          const value = { ...draft, upstream: draft.upstream.trim(), timeoutMs: Number(draft.timeoutMs), models };
          await scope.mutate([...savedFields.map(key => ({ op: 'set', path: [profilePath, key], value: value[key] })), { op: 'set', path: [profilePath, 'apiKeyEnv'], value: ref }], revision);
          setRevision(scope.getSnapshot().revision);
          if (apiKey.trim()) {
            const result = await ctx.remote.credentials.set(ref, apiKey.trim());
            if (!result.ok) throw new Error('credential write failed');
            setApiKey('');
          }
          setDirty(false); props.onClose(true);
        });
        const reset = () => { setDraft(draftOf({})); setDirty(true); setNotice(''); };
        const disabled = busy || !snapshot.writable || props.readOnly;
        const label = (title, child) => h('label', { className: css.field }, h('span', { className: css.fieldLabel }, title), child);
        const input = (value, onChange, extra = {}) => h('input', { className: css.input, value, onChange: e => onChange(e.target.value), disabled, ...extra });
        if (snapshot.status !== 'ready') return null;
        const keyLocked = credential?.writable === false;
        return h('div', { 'data-cline-pass-settings': true, className: css.editor },
          props.hideTitle ? null : h('div', { className: css.editorHeader }, h('span', { className: css.editorTitle }, props.displayName)),
          label(t('keyInput'), input(apiKey, setApiKey, { type: 'password', autoComplete: 'off', placeholder: t(keyLocked ? 'keyEnvLocked' : credential?.configured ? 'keyStored' : 'keyPlaceholderNative'), 'aria-label': t('keyInput'), disabled: disabled || keyLocked })),
          h('details', { className: css.customized },
            h('summary', { className: css.customizedSummary }, t('customized')),
            h('div', { className: css.customizedBody },
              h(ModelListEditor, { models: draft.models, overridden: draft.models.length > 0, onChange: models => change('models', models), onReset: () => change('models', []), t, disabled,
                probe: { settingsNs: NS, provider: props.provider }, operations: props.operations }),
              command ? null : label(copy('路由策略', 'Routing'), h('select', { className: css.input + ' ' + css.selectInput, value: draft.routing, disabled, onChange: e => change('routing', e.target.value) },
                h('option', { value: 'default' }, copy('默认', 'Default')), h('option', { value: 'sticky' }, copy('会话黏性', 'Session affinity')), h('option', { value: 'experimental-pin' }, copy('固定上游（实验性）', 'Fixed upstream (experimental)')))),
              draft.routing === 'experimental-pin' ? label(copy('上游提供方', 'Upstream provider'), input(draft.upstream, value => change('upstream', value), { placeholder: copy('提供方标识', 'Provider ID') })) : null,
              draft.routing === 'experimental-pin' ? h('p', { className: css.advancedHint }, copy('上游是否执行此限制尚未验证，缓存命中无法保证。', 'Enforcement by the upstream service is unverified; cache hits are not guaranteed.')) : null,
              label(copy('请求超时（毫秒）', 'Request timeout (ms)'), input(draft.timeoutMs, value => change('timeoutMs', value), { type: 'number', min: 1000, max: 1800000 })),
              command ? null : label(copy('诊断日志', 'Diagnostic logs'), h('span', { className: css.advancedHint }, h('input', { type: 'checkbox', checked: draft.diagnostics, disabled, onChange: e => change('diagnostics', e.target.checked) }), ' ', copy('记录 token 用量和耗时', 'Record token usage and timing'))),
              h('button', { type: 'button', className: css.linkButton, disabled, onClick: reset }, copy('恢复默认设置', 'Restore defaults')))),
          dirty && snapshot.revision !== revision ? h('p', { className: css.error, role: 'alert' }, t('conflict')) : null,
          notice ? h('p', { className: css.error, role: 'alert' }, notice) : null,
          h(EditorFooter, { t, busy, submitDisabled: disabled || keyLocked && !!apiKey.trim(), submitLabelKey: 'apply', submitBusyLabelKey: 'applying', onCancel: () => props.onClose(false), onSubmit: save }));
      }
      ctx.slots.inject('settings.models.provider-editor', () => ctx.slots.register({ name: 'settings.models.provider-editor', key: NS, id: NS }, Card));
    }
    return { inject: ['slots', 'connection', 'remote', 'remote.credentials', 'remote.llm', 'settingsScope'], apply };
  },
});
