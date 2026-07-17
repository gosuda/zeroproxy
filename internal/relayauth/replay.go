package relayauth

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

const MaxReplayRecords = 65536

var ErrReplay = errors.New("carrier replay rejected")

type ReplayKey struct {
	CapabilityID string
	Epoch        uint64
	ClientNonce  [32]byte
	ChallengeID  [24]byte
}

type replayRecord struct {
	Key       ReplayKey
	ExpiresAt time.Time
}

type ReplayLedger interface {
	Reserve(key ReplayKey, expiresAt, now time.Time) error
	BindChallenge(key ReplayKey, challengeID [24]byte) error
}

type MemoryReplayLedger struct {
	mu      sync.Mutex
	records map[ReplayKey]replayRecord
}

func NewMemoryReplayLedger() *MemoryReplayLedger {
	return &MemoryReplayLedger{records: make(map[ReplayKey]replayRecord)}
}

func pruneReplayRecords(records map[ReplayKey]replayRecord, now time.Time) {
	for key, record := range records {
		if !now.Before(record.ExpiresAt) {
			delete(records, key)
		}
	}
}

func replayPrefixExists(records map[ReplayKey]replayRecord, candidate ReplayKey) bool {
	for key := range records {
		if key.CapabilityID == candidate.CapabilityID && key.Epoch == candidate.Epoch && key.ClientNonce == candidate.ClientNonce {
			return true
		}
	}
	return false
}

func reserveReplay(records map[ReplayKey]replayRecord, key ReplayKey, expiresAt, now time.Time) error {
	pruneReplayRecords(records, now)
	if key.CapabilityID == "" || key.Epoch == 0 || key.ClientNonce == [32]byte{} ||
		!now.Before(expiresAt) || len(records) >= MaxReplayRecords {
		return ErrReplay
	}
	if replayPrefixExists(records, key) {
		return ErrReplay
	}
	records[key] = replayRecord{Key: key, ExpiresAt: expiresAt}
	return nil
}

func bindReplayChallenge(records map[ReplayKey]replayRecord, key ReplayKey, challengeID [24]byte) error {
	record, exists := records[key]
	if !exists || key.ChallengeID != [24]byte{} || challengeID == [24]byte{} {
		return ErrReplay
	}
	boundKey := key
	boundKey.ChallengeID = challengeID
	if _, exists := records[boundKey]; exists {
		return ErrReplay
	}
	delete(records, key)
	record.Key = boundKey
	records[boundKey] = record
	return nil
}

func (l *MemoryReplayLedger) Reserve(key ReplayKey, expiresAt, now time.Time) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return reserveReplay(l.records, key, expiresAt, now)
}

func (l *MemoryReplayLedger) BindChallenge(key ReplayKey, challengeID [24]byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return bindReplayChallenge(l.records, key, challengeID)
}

type replayLedgerFile struct {
	SchemaVersion int                      `json:"schema_version"`
	Records       []replayLedgerFileRecord `json:"records"`
}

type replayLedgerFileRecord struct {
	CapabilityID string `json:"capability_id"`
	Epoch        uint64 `json:"epoch"`
	ClientNonce  string `json:"client_nonce"`
	ChallengeID  string `json:"challenge_id"`
	ExpiresAt    string `json:"expires_at"`
}

type FileReplayLedger struct {
	mu      sync.Mutex
	path    string
	records map[ReplayKey]replayRecord
}

func initializeReplayMarker(path string) error {
	marker := path + ".initialized"
	file, err := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if errors.Is(err, os.ErrExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if _, err = file.WriteString("zeroproxy-replay-v1\n"); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}

func NewFileReplayLedger(path string) (*FileReplayLedger, error) {
	if path == "" || !filepath.IsAbs(path) {
		return nil, errors.New("absolute replay ledger path required")
	}
	ledger := &FileReplayLedger{path: path, records: make(map[ReplayKey]replayRecord)}
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		if _, markerErr := os.Stat(path + ".initialized"); markerErr == nil {
			return nil, ErrReplay
		} else if !errors.Is(markerErr, os.ErrNotExist) {
			return nil, markerErr
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			return nil, err
		}
		if err := ledger.persist(); err != nil {
			return nil, err
		}
		if err := initializeReplayMarker(path); err != nil {
			return nil, err
		}
		return ledger, nil
	}
	if err != nil {
		return nil, err
	}
	if err := ledger.decode(raw); err != nil {
		return nil, err
	}
	if err := initializeReplayMarker(path); err != nil {
		return nil, err
	}
	return ledger, nil
}

func decodeFixedHex(value string, size int) ([]byte, error) {
	if len(value) != size*2 {
		return nil, ErrReplay
	}
	decoded, err := hex.DecodeString(value)
	if err != nil || len(decoded) != size {
		return nil, ErrReplay
	}
	return decoded, nil
}

func (l *FileReplayLedger) decode(raw []byte) error {
	var document replayLedgerFile
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&document); err != nil || document.SchemaVersion != 1 || len(document.Records) > MaxReplayRecords {
		return ErrReplay
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return ErrReplay
	}
	for _, encoded := range document.Records {
		nonce, err := decodeFixedHex(encoded.ClientNonce, 32)
		if err != nil {
			return err
		}
		challenge, err := decodeFixedHex(encoded.ChallengeID, 24)
		if err != nil {
			return err
		}
		expiresAt, err := time.Parse(time.RFC3339Nano, encoded.ExpiresAt)
		if err != nil {
			return ErrReplay
		}
		key := ReplayKey{CapabilityID: encoded.CapabilityID, Epoch: encoded.Epoch}
		copy(key.ClientNonce[:], nonce)
		copy(key.ChallengeID[:], challenge)
		if key.CapabilityID == "" || key.Epoch == 0 || key.ClientNonce == [32]byte{} ||
			replayPrefixExists(l.records, key) {
			return ErrReplay
		}
		l.records[key] = replayRecord{Key: key, ExpiresAt: expiresAt}
	}
	return nil
}

func cloneReplayRecords(records map[ReplayKey]replayRecord) map[ReplayKey]replayRecord {
	clone := make(map[ReplayKey]replayRecord, len(records))
	for key, record := range records {
		clone[key] = record
	}
	return clone
}

func (l *FileReplayLedger) encoded() ([]byte, error) {
	records := make([]replayLedgerFileRecord, 0, len(l.records))
	for _, record := range l.records {
		records = append(records, replayLedgerFileRecord{
			CapabilityID: record.Key.CapabilityID,
			Epoch:        record.Key.Epoch,
			ClientNonce:  hex.EncodeToString(record.Key.ClientNonce[:]),
			ChallengeID:  hex.EncodeToString(record.Key.ChallengeID[:]),
			ExpiresAt:    record.ExpiresAt.UTC().Format(time.RFC3339Nano),
		})
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].CapabilityID != records[j].CapabilityID {
			return records[i].CapabilityID < records[j].CapabilityID
		}
		if records[i].Epoch != records[j].Epoch {
			return records[i].Epoch < records[j].Epoch
		}
		if records[i].ClientNonce != records[j].ClientNonce {
			return records[i].ClientNonce < records[j].ClientNonce
		}
		return records[i].ChallengeID < records[j].ChallengeID
	})
	return json.Marshal(replayLedgerFile{SchemaVersion: 1, Records: records})
}

func (l *FileReplayLedger) persist() error {
	raw, err := l.encoded()
	if err != nil {
		return err
	}
	temporary := l.path + ".tmp"
	file, err := os.OpenFile(temporary, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = file.Write(raw); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, l.path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	directory, err := os.Open(filepath.Dir(l.path))
	if err != nil {
		return err
	}
	err = directory.Sync()
	if closeErr := directory.Close(); err == nil {
		err = closeErr
	}
	return err
}

func (l *FileReplayLedger) mutate(operation func(map[ReplayKey]replayRecord) error) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	before := cloneReplayRecords(l.records)
	if err := operation(l.records); err != nil {
		return err
	}
	if err := l.persist(); err != nil {
		l.records = before
		return err
	}
	return nil
}

func (l *FileReplayLedger) Reserve(key ReplayKey, expiresAt, now time.Time) error {
	return l.mutate(func(records map[ReplayKey]replayRecord) error {
		return reserveReplay(records, key, expiresAt, now)
	})
}

func (l *FileReplayLedger) BindChallenge(key ReplayKey, challengeID [24]byte) error {
	return l.mutate(func(records map[ReplayKey]replayRecord) error {
		return bindReplayChallenge(records, key, challengeID)
	})
}
