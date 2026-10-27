import { ArrowRight, ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { errorText, useStore } from '../lib/store';

/** 手机号验证码登录（首次登录自动注册） */
export function Login() {
  const { login } = useStore();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [countdown, setCountdown] = useState(0);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const phoneOk = /^1[3-9]\d{9}$/.test(phone);

  useEffect(() => {
    if (countdown <= 0) return;
    const t = window.setTimeout(() => setCountdown((c) => c - 1), 1000);
    return () => window.clearTimeout(t);
  }, [countdown]);

  const send = async () => {
    setError('');
    setSending(true);
    try {
      const r = await api.sendCode(phone);
      setCountdown(60);
      if (r.dev_code) {
        setDevCode(r.dev_code);
        setCode(r.dev_code);
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!agree) return setError('请先阅读并同意用户协议、隐私政策与 AI 生成内容标识说明');
    setError('');
    setSubmitting(true);
    try {
      await login(phone, code);
    } catch (err) {
      setError(errorText(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="login">
      <form className="panel login-card" onSubmit={submit} noValidate>
        <div className="login-brand">
          <span className="rail-logo" aria-hidden="true">
            造
          </span>
          <div>
            <h1>登录造物</h1>
            <p className="muted">说出想法，造物帮你做完整套内容</p>
          </div>
        </div>
        <div className="field">
          <label htmlFor="login-phone">手机号</label>
          <input
            id="login-phone"
            className="input"
            inputMode="numeric"
            autoComplete="tel"
            maxLength={11}
            placeholder="请输入 11 位手机号"
            value={phone}
            onChange={(e) => setPhone(e.target.value.replace(/\D/g, ''))}
          />
        </div>
        <div className="field">
          <label htmlFor="login-code">验证码</label>
          <div className="login-code">
            <input
              id="login-code"
              className="input mono"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="6 位验证码"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
            <button type="button" className="btn" disabled={!phoneOk || countdown > 0 || sending} onClick={() => void send()}>
              {countdown > 0 ? `${countdown} 秒后重发` : sending ? '发送中…' : '获取验证码'}
            </button>
          </div>
          {devCode && <span className="subtle" style={{ fontSize: 12 }}>开发环境不发送短信，验证码已自动填入</span>}
        </div>
        <label className="login-agree">
          <input id="login-agree" type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          <span>我已阅读并同意《用户协议》《隐私政策》与《AI 生成内容标识说明》，知晓生成内容会添加 AI 标识</span>
        </label>
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn primary lg block" disabled={!phoneOk || code.length !== 6 || submitting}>
          {submitting ? '登录中…' : '登录 / 注册'} <ArrowRight size={16} />
        </button>
        <p className="subtle login-foot">
          <ShieldCheck size={14} /> 首次登录自动注册并赠送 100 积分，每日登录再送 20 积分
        </p>
      </form>
    </div>
  );
}
