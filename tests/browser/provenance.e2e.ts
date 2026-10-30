import { expect, test } from './ownerTest'

for (const locale of ['en', 'es']) {
  test(`original vitals provenance is visible in ${locale}`, async ({ page }) => {
    await page.goto(`/${locale}/sleep?view=biometrics`)
    await page.getByLabel('Biometrics date', { exact: true }).fill('2026-10-10')
    const notice = locale === 'en'
      ? 'These are original recorded readings. Charts separate known processing runs and HRV definitions. Legacy readings with unknown provenance remain unverified.'
      : 'Estas son las lecturas originales registradas. Los gráficos separan las ejecuciones de procesamiento y las definiciones de VFC conocidas. Las lecturas antiguas de procedencia desconocida siguen sin verificarse.'
    await expect(page.getByText(notice, { exact: true })).toBeVisible()
    await expect(page.getByText(locale === 'en'
      ? 'Recorded configurations: 0; readings with unknown configuration: 10.'
      : 'Configuraciones registradas: 0; lecturas con configuración desconocida: 10.', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Raw log', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await expect(dialog.getByRole('columnheader', { name: locale === 'en' ? 'Processing run' : 'Ejecución de procesamiento', exact: true })).toBeVisible()
    await expect(dialog.getByRole('columnheader', { name: locale === 'en' ? 'HRV definition' : 'Definición de VFC', exact: true })).toBeVisible()
    await dialog.screenshot({ animations: 'disabled', path: test.info().outputPath(`vitals-provenance-${locale}.png`) })
  })
}
