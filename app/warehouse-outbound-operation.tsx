'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { WarehouseOutboundState, WarehouseOutboundStep } from '../lib/warehouse-outbound-service';
import type { WarehouseOutboundOrder } from '../lib/warehouse-service';
import styles from './warehouse-outbound-operation.module.css';

type Props = {
  order: WarehouseOutboundOrder;
  onClose: () => void;
  onChanged: () => void;
  onShip: (order: WarehouseOutboundOrder) => Promise<boolean>;
};

const steps = [
  { id: 'pick', label: '拣货', button: '登记拣货' },
  { id: 'verify', label: '复核', button: '登记复核' },
  { id: 'pack', label: '打包', button: '登记打包' },
] as const;
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23',
});

export default function WarehouseOutboundOperation({ order, onClose, onChanged, onShip }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<{ revision: number; state: WarehouseOutboundState | null } | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [sku, setSku] = useState('');
  const [quantity, setQuantity] = useState('');
  const [packages, setPackages] = useState('');
  const state = read?.revision === revision ? read.state : null;
  const loading = read?.revision !== revision;
  const nextStep = state && state.orderStatus === 'reserved' ? steps[state.version] : undefined;
  const canShip = state?.orderStatus === 'reserved' && state.version === steps.length;
  const url = `/api/warehouse/outbound/${encodeURIComponent(order.id)}`;

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => {
      if (element?.open) element.close();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void readOutboundState(url, order.id, { signal: controller.signal })
      .then((response) => {
        if (!controller.signal.aborted) setRead({ revision, state: response });
      }).catch((readError) => {
        if (!controller.signal.aborted) {
          setRead({ revision, state: null });
          setError(displayError(readError));
        }
      });
    return () => controller.abort();
  }, [url, order.id, revision]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !state || !nextStep) return;
    const expectedVersion = state.version;
    let input: WarehouseOutboundStep;
    if (nextStep.id === 'pack') input = { step: 'pack', expectedVersion, packageCount: Number(packages) };
    else if (nextStep.id === 'verify') input = { step: 'verify', expectedVersion, quantity: Number(quantity), skuCode: sku.trim() };
    else input = { step: 'pick', expectedVersion, quantity: Number(quantity) };
    const body = JSON.stringify(input);
    const key = attempt.current?.body === body ? attempt.current.key : crypto.randomUUID();
    attempt.current = { body, key };
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      const response = await readOutboundState(url, order.id, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body,
      });
      setRead({ revision, state: response });
      setQuantity('');
      setSku('');
      setPackages('');
      attempt.current = null;
      onChanged();
    } catch (saveError) {
      setError(displayError(saveError));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  async function ship() {
    if (!canShip || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setError('');
    try {
      if (await onShip(order)) onClose();
      else setError('发货尚未确认，请核对当前步骤后重试。');
    } catch (shipError) {
      setError(displayError(shipError));
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }

  return <dialog className={`modal ${styles.modal}`} ref={dialog} aria-labelledby="warehouse-outbound-title"
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={save}>
      <header className="modal-head">
        <div><h2 id="warehouse-outbound-title">出库作业</h2><p>{order.orderNo} · {order.warehouseName}</p></div>
        <button type="button" aria-label="关闭出库作业" disabled={saving} onClick={onClose}>×</button>
      </header>
      <div className={styles.body}>
        <div className={styles.target}><strong>{state?.skuCode ?? order.skuCode}</strong><span>预占 {state?.quantity ?? order.quantity} 件</span></div>
        {loading ? <p role="status">正在读取出库步骤…</p> : state && <>
          <ol className={styles.steps} aria-label="出库步骤">
            {steps.map((step) => {
              const completed = state.events.find((entry) => entry.step === step.id);
              const current = nextStep?.id === step.id;
              return <li key={step.id} data-status={completed ? 'complete' : current ? 'current' : 'pending'} aria-current={current ? 'step' : undefined}>
                <strong>{step.label}</strong><span>{completed
                  ? `${completed.quantity ?? completed.packageCount} ${step.id === 'pack' ? '箱' : '件'}`
                  : current ? '待登记' : '未完成'}</span>
                {completed && <time dateTime={completed.createdAt}>{timeFormat.format(new Date(completed.createdAt))}</time>}
              </li>;
            })}
          </ol>
          {state.orderStatus !== 'reserved' && <p role="status">订单预占已结束，请在订单列表查看当前状态。</p>}
          {canShip && <p role="status">打包已登记，可以确认发货。</p>}
        </>}
        {error && <div className={styles.error} role="alert"><span>{error}</span><button type="button" disabled={saving || loading} onClick={() => {
          setError('');
          setRevision((current) => current + 1);
        }}>刷新步骤</button></div>}
      </div>
      {nextStep && <div className="form-grid">
        {nextStep.id === 'verify' && <label>实物 SKU<input required maxLength={160} value={sku} disabled={saving}
          onChange={(event) => setSku(event.target.value)} /></label>}
        {nextStep.id !== 'pack' ? <label>{nextStep.id === 'pick' ? '实际拣货件数' : '复核件数'}
          <input type="number" inputMode="numeric" min={1} max={2_147_483_647} step={1} required value={quantity} disabled={saving}
            onChange={(event) => setQuantity(event.target.value)} /></label>
          : <label>打包箱数<input type="number" inputMode="numeric" min={1} max={2_147_483_647} step={1} required value={packages} disabled={saving}
            onChange={(event) => setPackages(event.target.value)} /></label>}
      </div>}
      <footer className="modal-actions">
        <button type="button" disabled={saving} onClick={onClose}>关闭</button>
        {nextStep && <button type="submit" className="primary-button" disabled={saving}>{saving ? '正在登记…' : nextStep.button}</button>}
        {canShip && <button type="button" className="primary-button" disabled={saving} onClick={() => { void ship(); }}>
          {saving ? '正在确认…' : '确认发货'}
        </button>}
      </footer>
    </form>
  </dialog>;
}

async function readOutboundState(url: string, orderId: string, options: RequestInit) {
  const response = await fetch(url, { ...options, cache: 'no-store' });
  const result = await response.json().catch(() => null) as { ok?: boolean; message?: string; state?: WarehouseOutboundState } | null;
  if (!response.ok || !result?.ok || result.state?.orderId !== orderId || !Array.isArray(result.state.events)) {
    throw new Error(result?.message ?? '暂时无法读取出库作业，请重试。');
  }
  return result.state;
}

function displayError(error: unknown) {
  return error instanceof Error && error.message ? error.message : '出库作业暂时无法继续，请刷新后重试。';
}
