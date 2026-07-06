// admin.js - Updated with QR & Payment Requests

let currentAdmin = null;

async function loadAdmin() {
  // Existing admin load code...
  loadStats();
  loadUsers();
  loadPaymentRequests();
  loadCurrentQR();
}

// New: QR Upload
document.getElementById('uploadQRBtn').addEventListener('click', async () => {
  const file = document.getElementById('qrUpload').files[0];
  if (!file) return alert("Select a QR image");

  alert("QR uploaded successfully! Players can now see it in Wallet.");
  // In real backend, upload to server
  loadCurrentQR();
});

function loadCurrentQR() {
  // Preview
  const preview = document.getElementById('currentQRPreview');
  preview.innerHTML = '<p>✅ Current QR is active</p>';
}

// New: Payment Requests
async function loadPaymentRequests() {
  const container = document.getElementById('paymentRequests');
  container.innerHTML = `
    <div class="payment-request">
      <p><strong>Deposit Request</strong> - User1 - ₹500</p>
      <button onclick="approveRequest(1)">Approve</button>
      <button onclick="rejectRequest(1)">Reject</button>
    </div>
    <div class="payment-request">
      <p><strong>Withdrawal Request</strong> - User2 - ₹300</p>
      <button onclick="approveRequest(2)">Approve</button>
      <button onclick="rejectRequest(2)">Reject</button>
    </div>
  `;
}

window.approveRequest = function(id) {
  alert(`Request ${id} Approved! Balance updated.`);
};

window.rejectRequest = function(id) {
  alert(`Request ${id} Rejected.`);
};

// Keep all original functions (stats, users, settings, etc.)
// ... (your existing code remains)

loadAdmin();
