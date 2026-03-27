
import React, { useState, useRef } from 'react';
import { useOS } from '../../context/OSContext';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

const NETLIFY_HOST = 'sullyos.netlify.app';
const STABLE_URL = 'https://qegj567-cloud.github.io/SullyOS/';

const EmergencyNetlifyPopup: React.FC = () => {
  const { exportSystem, sysOperation } = useOS();
  const [exporting, setExporting] = useState(false);
  const isNetlify = typeof window !== 'undefined' && window.location.hostname === NETLIFY_HOST;

  if (!isNetlify) return null;

  const handleExport = async (mode: 'text_only' | 'media_only' | 'full') => {
    try {
      setExporting(true);
      const blob = await exportSystem(mode);

      if (Capacitor.isNativePlatform()) {
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = async () => {
          const base64data = String(reader.result);
          const fileName = `Sully_Backup_${mode}_${Date.now()}.zip`;
          try {
            await Filesystem.writeFile({ path: fileName, data: base64data, directory: Directory.Cache });
            const uriResult = await Filesystem.getUri({ directory: Directory.Cache, path: fileName });
            await Share.share({ title: 'Sully Backup', files: [uriResult.uri] });
          } catch { /* ignore native errors */ }
        };
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Sully_Backup_${mode}_${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
    } catch (e: any) {
      alert('导出失败: ' + (e.message || '未知错误'));
    } finally {
      setExporting(false);
    }
  };

  const isProcessing = sysOperation.status === 'processing' || exporting;

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 999999,
      background: 'rgba(0,0,0,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '16px',
    }}>
      <div style={{
        background: '#fff', borderRadius: '20px', maxWidth: '400px', width: '100%',
        padding: '28px 24px', boxShadow: '0 25px 50px rgba(0,0,0,0.5)',
        maxHeight: '90vh', overflowY: 'auto',
      }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: '20px' }}>
          <div style={{
            width: '56px', height: '56px', borderRadius: '50%',
            background: '#FEE2E2', display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 12px', fontSize: '28px',
          }}>
            ⚠️
          </div>
          <h1 style={{ fontSize: '20px', fontWeight: 800, color: '#DC2626', margin: '0 0 4px' }}>
            紧急公告
          </h1>
          <p style={{ fontSize: '11px', color: '#94A3B8', margin: 0 }}>EMERGENCY NOTICE</p>
        </div>

        {/* Warning content */}
        <div style={{
          background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '12px',
          padding: '16px', marginBottom: '16px', fontSize: '13px', lineHeight: '1.7', color: '#991B1B',
        }}>
          <p style={{ margin: '0 0 10px' }}>
            <b>你正在使用的链接是：</b>
          </p>
          <p style={{
            margin: '0 0 10px', padding: '8px 12px', background: '#DC2626', color: '#fff',
            borderRadius: '8px', fontSize: '12px', wordBreak: 'break-all', fontWeight: 700,
          }}>
            https://sullyos.netlify.app/
          </p>
          <p style={{ margin: '0 0 10px' }}>
            管理员的余额已经烧空！之前已经警告过该网站不稳定，请立即迁移至稳定版本。
          </p>
          <p style={{ margin: '0 0 4px', fontWeight: 700 }}>
            请迁移至稳定版本链接：
          </p>
          <a
            href={STABLE_URL}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'block', padding: '10px 14px', background: '#059669', color: '#fff',
              borderRadius: '8px', fontSize: '12px', fontWeight: 700, textDecoration: 'none',
              textAlign: 'center', wordBreak: 'break-all',
            }}
          >
            {STABLE_URL}
          </a>
        </div>

        {/* Instructions */}
        <div style={{
          background: '#F0F9FF', border: '1px solid #BAE6FD', borderRadius: '12px',
          padding: '14px', marginBottom: '20px', fontSize: '12px', lineHeight: '1.6', color: '#0C4A6E',
        }}>
          <p style={{ margin: '0 0 6px', fontWeight: 700 }}>迁移步骤：</p>
          <p style={{ margin: 0 }}>
            1. 点击下方按钮导出你的数据备份<br/>
            2. 打开稳定版链接<br/>
            3. 在设置中导入备份文件
          </p>
        </div>

        {/* Progress */}
        {isProcessing && (
          <div style={{
            background: '#FFF7ED', border: '1px solid #FED7AA', borderRadius: '12px',
            padding: '12px 14px', marginBottom: '16px', fontSize: '12px', color: '#9A3412', textAlign: 'center',
          }}>
            <p style={{ margin: '0 0 6px', fontWeight: 700 }}>
              {sysOperation.message || '正在导出...'}
            </p>
            <div style={{
              width: '100%', height: '6px', background: '#FED7AA', borderRadius: '3px', overflow: 'hidden',
            }}>
              <div style={{
                width: `${sysOperation.progress}%`, height: '100%',
                background: '#F97316', borderRadius: '3px', transition: 'width 0.3s',
              }} />
            </div>
            <p style={{ margin: '6px 0 0', fontSize: '11px' }}>{sysOperation.progress}%</p>
          </div>
        )}

        {/* Export buttons */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <button
            onClick={() => handleExport('full')}
            disabled={isProcessing}
            style={{
              width: '100%', padding: '14px', border: 'none', borderRadius: '12px',
              background: isProcessing ? '#C4B5FD' : 'linear-gradient(135deg, #8B5CF6, #7C3AED)',
              color: '#fff', fontSize: '14px', fontWeight: 700, cursor: isProcessing ? 'not-allowed' : 'pointer',
            }}
          >
            📦 整合导出（文字 + 媒体）
          </button>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
            <button
              onClick={() => handleExport('text_only')}
              disabled={isProcessing}
              style={{
                padding: '12px 8px', border: '1px solid #E2E8F0', borderRadius: '12px',
                background: isProcessing ? '#F1F5F9' : '#fff', color: '#475569',
                fontSize: '12px', fontWeight: 700, cursor: isProcessing ? 'not-allowed' : 'pointer',
              }}
            >
              📄 纯文字备份
            </button>
            <button
              onClick={() => handleExport('media_only')}
              disabled={isProcessing}
              style={{
                padding: '12px 8px', border: '1px solid #E2E8F0', borderRadius: '12px',
                background: isProcessing ? '#F1F5F9' : '#fff', color: '#475569',
                fontSize: '12px', fontWeight: 700, cursor: isProcessing ? 'not-allowed' : 'pointer',
              }}
            >
              🖼️ 媒体素材备份
            </button>
          </div>
        </div>

        {/* Footer */}
        <p style={{
          textAlign: 'center', fontSize: '11px', color: '#94A3B8',
          marginTop: '16px', marginBottom: 0,
        }}>
          该弹窗无法关闭 · 请导出数据后迁移至稳定版本
        </p>
      </div>
    </div>
  );
};

export default EmergencyNetlifyPopup;
