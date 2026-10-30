import { DELETION_COOLING_DAYS } from '@creature/shared';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { fmt } from '../lib/mock';
import { errorText, useStore } from '../lib/store';
import { Drawer } from './ui';

/** 账号与隐私：导出个人信息副本、注销账号（docs/08-compliance.md 第 5 节） */
export function AccountDrawer({ onClose }: { onClose: () => void }) {
  const { state, toast, deleteAccount } = useStore();
  const [exporting, setExporting] = useState(false);
  const [agree, setAgree] = useState(false);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = state.profile;

  const exportData = async () => {
    setExporting(true);
    try {
      const data = await api.exportMe();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `creature-personal-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('已导出个人信息副本；其中的作品下载地址 2 小时内有效');
    } catch (e) {
      toast(errorText(e), 'err');
    } finally {
      setExporting(false);
    }
  };

  const sendCode = async () => {
    try {
      const r = await api.deletionCode();
      setSent(true);
      // 开发模式直接回填验证码
      if (r.dev_code) setCode(r.dev_code);
      toast(`验证码已发送到 ${p?.phoneMasked ?? '绑定的手机号'}`);
    } catch (e) {
      toast(errorText(e), 'err');
    }
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await deleteAccount(code);
    } catch (e) {
      toast(errorText(e), 'err');
      setBusy(false);
    }
  };

  return (
    <Drawer title="账号与隐私" onClose={onClose}>
      <section className="field" aria-labelledby="acct-export">
        <h4 id="acct-export" style={{ fontSize: 14 }}>
          导出个人信息
        </h4>
        <p className="subtle" style={{ fontSize: 12.5 }}>
          包含账号资料、积分与订单、生成记录、作品清单（附下载地址）、广场发布、角色与品牌套件。每天最多导出 5 次。
        </p>
        <button className="btn" style={{ alignSelf: 'flex-start' }} disabled={exporting} onClick={() => void exportData()}>
          <Download size={14} /> {exporting ? '正在导出…' : '导出 JSON'}
        </button>
      </section>

      <section className="field danger-zone" aria-labelledby="acct-delete">
        <h4 id="acct-delete" style={{ fontSize: 14 }}>
          注销账号
        </h4>
        <ul className="subtle" style={{ fontSize: 12.5, paddingLeft: 18, display: 'grid', gap: 4 }}>
          <li>提交后立即退出所有设备，进入 {DELETION_COOLING_DAYS} 天冷静期；期间用本手机号重新登录即可撤销。</li>
          <li>冷静期满后：作品与文件、广场发布、角色、品牌套件、项目与画布全部删除，昵称与手机号清除，无法恢复。</li>
          <li>
            剩余 <b>{fmt(state.available)}</b> 积分{p?.planCode !== 'free' ? `与${p?.planName}会员权益` : ''}将作废，不予退款。
          </li>
          <li>按法规要求，生成记录、订单与积分流水会在匿名化后继续保留一段时间。</li>
          <li>有正在生成的任务时不能注销，请等待完成或取消。</li>
        </ul>
        <label className="check-row">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
          我已了解以上内容，确认注销账号
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <label htmlFor="acct-code" className="visually-hidden">
            短信验证码
          </label>
          <input
            id="acct-code"
            className="input"
            style={{ flex: 1 }}
            inputMode="numeric"
            maxLength={6}
            placeholder="短信验证码"
            value={code}
            disabled={!agree}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <button className="btn" disabled={!agree} onClick={() => void sendCode()}>
            {sent ? '重新获取' : '获取验证码'}
          </button>
        </div>
        <button className="btn danger" disabled={!agree || code.length !== 6 || busy} onClick={() => void confirm()}>
          {busy ? '正在提交…' : '确认注销'}
        </button>
      </section>
    </Drawer>
  );
}
