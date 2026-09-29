import pandas as pd
import matplotlib.pyplot as plt
import os
from datetime import datetime

# Paths
EIGHT_SLEEP_VITALS = "sample_data/eight_sleep/export_vitals.csv"
APPLE_WATCH_HR = "sample_data/apple_watch/heart_rate.csv"
APPLE_WATCH_RR = "sample_data/apple_watch/respiratory_rate.csv"

def load_eight_sleep():
    print(f"Loading Eight Sleep data from {EIGHT_SLEEP_VITALS}...")
    df = pd.read_csv(EIGHT_SLEEP_VITALS)
    # Convert unix timestamp to datetime (UTC)
    df['dt'] = pd.to_datetime(df['timestamp'], unit='s', utc=True).dt.as_unit('ns')
    return df

def load_apple_watch():
    print(f"Loading Apple Watch heart rate from {APPLE_WATCH_HR}...")
    hr_df = pd.read_csv(APPLE_WATCH_HR)
    # Apple Watch format: 2026-04-27 18:30:06 -0400
    hr_df['dt'] = pd.to_datetime(hr_df['startDate'], utc=True).dt.as_unit('ns')
    
    print(f"Loading Apple Watch respiratory rate from {APPLE_WATCH_RR}...")
    rr_df = pd.read_csv(APPLE_WATCH_RR)
    rr_df['dt'] = pd.to_datetime(rr_df['startDate'], utc=True).dt.as_unit('ns')
    
    return hr_df, rr_df

def align_and_compare():
    es_df = load_eight_sleep()
    aw_hr_df, aw_rr_df = load_apple_watch()

    # Sort for merge_asof
    es_df = es_df.sort_values('dt')
    aw_hr_df = aw_hr_df.sort_values('dt')
    aw_rr_df = aw_rr_df.sort_values('dt')

    # Filter Eight Sleep to remove rows with no heart rate
    es_df = es_df.dropna(subset=['heart_rate'])

    # Comparison for each side
    for side in es_df['side'].unique():
        print(f"\n--- Analysis for {side} side ---")
        side_df = es_df[es_df['side'] == side].copy()
        
        # Align HR
        aligned_hr = pd.merge_asof(
            side_df[['dt', 'heart_rate', 'breathing_rate']], 
            aw_hr_df[['dt', 'value']].rename(columns={'value': 'aw_hr'}),
            on='dt',
            direction='nearest',
            tolerance=pd.Timedelta('10min')
        ).dropna(subset=['aw_hr'])

        # Align RR
        aligned = pd.merge_asof(
            aligned_hr,
            aw_rr_df[['dt', 'value']].rename(columns={'value': 'aw_rr'}),
            on='dt',
            direction='nearest',
            tolerance=pd.Timedelta('10min')
        ).dropna(subset=['aw_rr'])

        if aligned.empty:
            print(f"No aligned data found for {side} side within 10-min tolerance.")
            continue

        print(f"Found {len(aligned)} aligned samples.")

        # Metrics
        hr_mae = (aligned['heart_rate'] - aligned['aw_hr']).abs().mean()
        hr_corr = aligned['heart_rate'].corr(aligned['aw_hr'])
        
        rr_mae = (aligned['breathing_rate'] - aligned['aw_rr']).abs().mean()
        rr_corr = aligned['breathing_rate'].corr(aligned['aw_rr'])

        print(f"Heart Rate MAE: {hr_mae:.2f} bpm")
        print(f"Heart Rate Correlation: {hr_corr:.4f}")
        print(f"Respiratory Rate MAE: {rr_mae:.2f} breaths/min")
        print(f"Respiratory Rate Correlation: {rr_corr:.4f}")

        # Lag search (test offsets from -60 to +60 minutes)
        best_corr = -1.0
        best_offset = 0
        for offset_min in range(-60, 61):
            shifted_side_df = side_df.copy()
            shifted_side_df['dt'] = shifted_side_df['dt'] + pd.Timedelta(minutes=offset_min)
            
            test_aligned = pd.merge_asof(
                shifted_side_df.sort_values('dt'),
                aw_hr_df[['dt', 'value']].rename(columns={'value': 'aw_hr'}).sort_values('dt'),
                on='dt',
                direction='nearest',
                tolerance=pd.Timedelta('5min')
            ).dropna(subset=['aw_hr', 'heart_rate'])
            
            if len(test_aligned) > 10:
                corr = test_aligned['heart_rate'].corr(test_aligned['aw_hr'])
                if corr > best_corr:
                    best_corr = corr
                    best_offset = offset_min
        
        print(f"Best HR Correlation: {best_corr:.4f} at {best_offset} min offset")

        # Print first 10 aligned samples
        print("\nSample aligned records:")
        print(aligned[['dt', 'heart_rate', 'aw_hr', 'breathing_rate', 'aw_rr']].head(10).to_string())

        # Plotting (one file per side)
        fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(12, 10), sharex=True)

        ax1.plot(aligned['dt'], aligned['aw_hr'], 'o-', label='Apple Watch', alpha=0.5, markersize=3)
        ax1.plot(aligned['dt'], aligned['heart_rate'], 'o-', label='Eight Sleep', alpha=0.8, markersize=3)
        ax1.set_ylabel('Heart Rate (bpm)')
        ax1.set_title(f'Heart Rate Comparison ({side} side)')
        ax1.legend()
        ax1.grid(True, alpha=0.3)

        ax2.plot(aligned['dt'], aligned['aw_rr'], 'o-', label='Apple Watch', alpha=0.5, markersize=3)
        ax2.plot(aligned['dt'], aligned['breathing_rate'], 'o-', label='Eight Sleep', alpha=0.8, markersize=3)
        ax2.set_ylabel('Respiratory Rate (br/min)')
        ax2.set_title(f'Respiratory Rate Comparison ({side} side)')
        ax2.legend()
        ax2.grid(True, alpha=0.3)

        plt.tight_layout()
        output_plot = f"scratch/comparison_plot_{side}.png"
        plt.savefig(output_plot)
        print(f"Plot saved to {output_plot}")

    # Overall ranges for debugging
    print("\n--- Data Ranges ---")
    print(f"Eight Sleep: {es_df['dt'].min()} to {es_df['dt'].max()}")
    print(f"Apple Watch HR: {aw_hr_df['dt'].min()} to {aw_hr_df['dt'].max()}")
    print(f"Apple Watch RR: {aw_rr_df['dt'].min()} to {aw_rr_df['dt'].max()}")

if __name__ == "__main__":
    align_and_compare()
