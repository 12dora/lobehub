'use client';

import { Button, DropdownMenu, Flexbox, Icon, Text } from '@lobehub/ui';
import { GithubIcon } from '@lobehub/ui/icons';
import { FileArchive, Grid2x2Plus, Link, Store } from 'lucide-react';
import { memo, useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAdminToolScope } from '@/features/AdminToolScope';
import { CustomConnectorModal } from '@/features/Connectors';
import { masterDetailSurfaceStyles } from '@/features/SettingsCatalogSurface';
import { createSkillStoreModal } from '@/features/SkillStore';
import { openImportFromGithubModal } from '@/features/SkillStore/SkillList/ImportFromGithubModal';
import { openImportFromUrlModal } from '@/features/SkillStore/SkillList/ImportFromUrlModal';
import { openUploadSkillModal } from '@/features/SkillStore/SkillList/UploadSkillModal';

import { type ToolDetailType } from './SkillDetail';
import SkillList, { type SkillViewMode } from './SkillList';

const styles = masterDetailSurfaceStyles;

interface LeftPanelProps {
  managed?: boolean;
  onDeleteSelected: () => void;
  onSelect: (identifier: string, type: ToolDetailType) => void;
  selectedIdentifier?: string;
  viewMode: SkillViewMode;
}

/**
 * User settings left pane. Uses the same master-detail chrome tokens as
 * admin `/admin/ai/skills|connectors` (masterDetailSurfaceStyles).
 */
const LeftPanel = memo<LeftPanelProps>(
  ({ managed = false, onDeleteSelected, onSelect, selectedIdentifier, viewMode }) => {
    const { t } = useTranslation('setting');
    const [showAddConnector, setShowAddConnector] = useState(false);
    const adminScope = useAdminToolScope();

    const handleOpenStore = useCallback(() => {
      createSkillStoreModal(adminScope);
    }, [adminScope]);

    const isConnectorView = viewMode === 'connector';

    return (
      <>
        <div className={styles.left}>
          <div className={styles.leftHeader}>
            <Text strong style={{ fontSize: 14 }}>
              {isConnectorView
                ? t('skillView.connectors', 'Connectors')
                : t('skillView.skills', 'Skills')}
            </Text>

            {!managed ? (
              <div style={{ display: 'flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
                {isConnectorView ? (
                  <Button
                    icon={Grid2x2Plus}
                    size="small"
                    title={t('connector.add.title', {
                      defaultValue: 'Add Custom Connector',
                      ns: 'tool',
                    })}
                    onClick={() => setShowAddConnector(true)}
                  />
                ) : (
                  <DropdownMenu
                    nativeButton={false}
                    placement="bottomRight"
                    items={[
                      {
                        icon: <Icon icon={Link} />,
                        key: 'importUrl',
                        label: (
                          <Flexbox gap={2}>
                            <span>{t('tab.importFromUrl')}</span>
                            <Text style={{ fontSize: 12 }} type="secondary">
                              {t('tab.importFromUrl.desc')}
                            </Text>
                          </Flexbox>
                        ),
                        onClick: () =>
                          openImportFromUrlModal(
                            adminScope
                              ? { onImport: ({ url }) => adminScope.importFromUrl(url) }
                              : undefined,
                          ),
                      },
                      {
                        icon: <Icon icon={GithubIcon} />,
                        key: 'importGithub',
                        label: (
                          <Flexbox gap={2}>
                            <span>{t('tab.importFromGithub')}</span>
                            <Text style={{ fontSize: 12 }} type="secondary">
                              {t('tab.importFromGithub.desc')}
                            </Text>
                          </Flexbox>
                        ),
                        onClick: () =>
                          openImportFromGithubModal(
                            adminScope
                              ? { onImport: ({ gitUrl }) => adminScope.importFromGithub(gitUrl) }
                              : undefined,
                          ),
                      },
                      {
                        icon: <Icon icon={FileArchive} />,
                        key: 'uploadZip',
                        label: (
                          <Flexbox gap={2}>
                            <span>{t('tab.uploadZip')}</span>
                            <Text style={{ fontSize: 12 }} type="secondary">
                              {t('tab.uploadZip.desc')}
                            </Text>
                          </Flexbox>
                        ),
                        onClick: () =>
                          openUploadSkillModal(
                            adminScope
                              ? { onImportFile: (file) => adminScope.importFromZip(file) }
                              : undefined,
                          ),
                      },
                    ]}
                  >
                    <Button icon={Grid2x2Plus} size="small" />
                  </DropdownMenu>
                )}
                <Button icon={<Icon icon={Store} />} size="small" onClick={handleOpenStore} />
              </div>
            ) : null}
          </div>

          <div className={styles.leftBody}>
            <SkillList
              managed={managed}
              selectedIdentifier={selectedIdentifier}
              viewMode={viewMode}
              onDeleteSelected={onDeleteSelected}
              onSelect={onSelect}
            />
          </div>
        </div>
        {!managed ? (
          <CustomConnectorModal
            open={showAddConnector}
            onClose={() => setShowAddConnector(false)}
          />
        ) : null}
      </>
    );
  },
);

LeftPanel.displayName = 'SkillSettingsLeftPanel';

export default LeftPanel;
