function getTodayDateString() {
    const today = new Date();
    today.setMinutes(today.getMinutes() - today.getTimezoneOffset()); // Convert to local time
    return today.toISOString().split('T')[0]; // Extract YYYY-MM-DD
}

export { getTodayDateString };
